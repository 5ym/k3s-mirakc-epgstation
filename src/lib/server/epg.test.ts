import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 局だけの取り込み。
 *
 * どの局が居るかを知っているのは**エージェント** (チャンネルスキャンの結果) で、
 * 番組表を集めるのは denpa 自身。集めるほうは1チャンネルに数分かかるので、
 * 局だけ先に取り込めることを確かめる。
 *
 * 環境変数ではなく設定そのものを書き換えている (files.test.ts と同じ理由)。
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-epg-')), 'denpa.db');

/** 何を取りに来たか。番組表を取りに行っていないことまで見る */
const asked: string[] = [];

function channel(serviceId: number, name: string, serviceType = 1) {
    return {
        type: 'GR',
        channel: 'T16',
        networkId: 32391,
        transportStreamId: 32391,
        remoteControlKeyId: 9,
        services: [{ serviceId, serviceType, name }],
    };
}

/** エージェントが返すチャンネル。テストの途中で入れ替える */
let offered = [
    channel(23608, 'ＴＯＫＹＯ　ＭＸ'),
    // データ放送。映像が入っていないので取り込まない
    channel(700, 'ＭＸデータ１', 192),
];

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const path = new URL(request.url).pathname;
        asked.push(path);
        if (path === '/denpa/channels') return Response.json(offered);
        return new Response('not found', { status: 404 });
    },
});
config.agentUrl = `http://127.0.0.1:${server.port}`;

const { database } = await import('./db');
const { airing, syncServicesOnly } = await import('./epg');

describe('syncServicesOnly', () => {
    test('番組表を待たずに局だけ取り込む', async () => {
        expect(await syncServicesOnly()).toBe(1);

        const rows = database().query('SELECT id, name, type FROM services').all();
        // 全角英数は取り込むときに直す。他の画面と字面がずれると別の局に見える
        // 内部IDは networkId * 100000 + serviceId。録画が参照しているので変えられない
        expect(rows).toEqual([{ id: 3239123608, name: 'TOKYO MX', type: 'GR' }]);

        // 選局していないこと。局の一覧はスキャンの結果を読むだけで手に入る
        expect(asked).toEqual(['/denpa/channels']);
        expect(database().query('SELECT COUNT(*) AS n FROM programs').get()).toEqual({ n: 0 });
    });

    test('何度呼んでも増えない', async () => {
        await syncServicesOnly();
        expect(database().query('SELECT COUNT(*) AS n FROM services').get()).toEqual({ n: 1 });
    });
});

/**
 * 選局できなくなった局の片付け。
 *
 * スキャンをやり直すと局は普通に入れ替わる。番組表を置いたままにしていた頃は、
 * もう選局できない局の番組が数万件残り、検索にも引っかかり続けていた。
 */
describe('消えた局の片付け', () => {
    const db = () => database();

    function seed(serviceId: number): void {
        db().exec('DELETE FROM programs; DELETE FROM reservations');
        db()
            .prepare(
                `INSERT INTO programs (id, service_id, network_id, event_id, start_at, end_at, name,
                                   description, is_free, updated_at)
             VALUES (1, ?, 32391, 1, ?, ?, '消える局の番組', '', 1, ?)`,
            )
            .run(serviceId, Date.now(), Date.now() + 1800_000, Date.now());
        db()
            .prepare(
                `INSERT INTO reservations (id, program_id, service_id, name, description, start_at, end_at,
                                       state, created_at, updated_at)
             VALUES (1, 1, ?, '消える局の予約', '', ?, ?, 'scheduled', ?, ?)`,
            )
            .run(serviceId, Date.now(), Date.now() + 1800_000, Date.now(), Date.now());
    }

    test('番組表は消し、まだ始めていない予約は取り消す。局の行は残す', async () => {
        await syncServicesOnly();
        seed(3239123608);

        // 局が丸ごと入れ替わった (スキャンのやり直し)
        offered = [channel(23609, '別の局')];
        await syncServicesOnly();

        expect(db().query('SELECT COUNT(*) AS n FROM programs').get()).toEqual({ n: 0 });
        expect(db().query('SELECT state FROM reservations WHERE id = 1').get()).toEqual({
            state: 'canceled',
        });
        /*
         * 局の行そのものは残す。消すと、その局で録った録画や過去の予約が
         * 辿れなくなる。画面に出さない仕組みは別にある (CURRENT_SERVICES)
         */
        expect(db().query('SELECT COUNT(*) AS n FROM services').get()).toEqual({ n: 2 });
    });

    test('1局も返ってこなかった回では何もしない', async () => {
        offered = [channel(23608, 'ＴＯＫＹＯ　ＭＸ')];
        await syncServicesOnly();
        seed(3239123608);

        /*
         * エージェントは起動直後や不調で空を返すことがある。それを「全部消えた」と
         * 読むと、次の取り込みまで番組表が丸ごと消える
         */
        offered = [];
        await syncServicesOnly();

        expect(db().query('SELECT COUNT(*) AS n FROM programs').get()).toEqual({ n: 1 });
        expect(db().query('SELECT state FROM reservations WHERE id = 1').get()).toEqual({
            state: 'scheduled',
        });
    });
});

/**
 * 枠はあるが放送していない局を、番組表から外す。
 *
 * - 終わったチャンネル (BS103 は 2024年3月で放送終了。SDT に枠だけ残る)
 * - 相乗り中のサブチャンネル (NHK総合2 は、マルチ編成でない間ずっと名前が無い)
 */
describe('番組表に出す局', () => {
    const service = (id: number) => ({ id });
    const program = (serviceId: number, name: string) => ({ service_id: serviceId, name });

    test('名前の付いた番組が1つも無い局は出さない', () => {
        const services = [service(1), service(2), service(3)];
        const programs = [
            program(1, 'ニュース'),
            // 相乗り中のサブチャンネル。名前の無い番組だけが並ぶ
            program(2, ''),
            program(2, ''),
            // 3 は終わったチャンネル。番組が1つも来ない
        ];

        expect(airing(services, programs).map((s) => s.id)).toEqual([1]);
    });

    test('1つでも名前が付いていれば出す', () => {
        // マルチ編成の日だけサブチャンネルにも名前が付く
        const services = [service(1), service(2)];
        const programs = [program(2, ''), program(2, '大相撲')];

        expect(airing(services, programs).map((s) => s.id)).toEqual([2]);
    });

    test('1局も残らないときは全部出す', () => {
        // 入れたばかりで番組表が空のとき。列ごと消えると先へ進めない
        const services = [service(1), service(2)];

        expect(airing(services, []).map((s) => s.id)).toEqual([1, 2]);
    });
});
