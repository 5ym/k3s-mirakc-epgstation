import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 局だけの取り込み。
 *
 * mirakc は局と番組表を**別々に持っている**。知らせが飛んでくるのは番組表のぶんだけ
 * (`epg.programs-updated`) で、局が揃ったことは教えてくれない。初回起動や
 * チャンネルスキャンの直後は「局は分かったが番組表はこれから」が数十分続くので、
 * 番組表を待たずに局だけ先に取り込めることを確かめる。
 *
 * 環境変数ではなく設定そのものを書き換えている (files.test.ts と同じ理由)。
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-epg-')), 'denpa.db');

/** 何を取りに来たか。番組表を取りに行っていないことまで見る */
const asked: string[] = [];

function service(id: number, name: string, type = 1) {
    return {
        id,
        serviceId: id % 100000,
        networkId: 32391,
        name,
        type,
        channel: { type: 'GR', channel: 'T16' },
    };
}

/** mirakc が返す局。テストの途中で入れ替える */
let offered = [
    service(3239123608, 'ＴＯＫＹＯ　ＭＸ'),
    // データ放送。映像が入っていないので取り込まない
    service(3239100700, 'ＭＸデータ１', 192),
];

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const path = new URL(request.url).pathname;
        asked.push(path);
        if (path === '/api/services') return Response.json(offered);
        return new Response('not found', { status: 404 });
    },
});
config.mirakcUrl = `http://127.0.0.1:${server.port}`;

const { database } = await import('./db');
const { syncServicesOnly } = await import('./epg');

describe('syncServicesOnly', () => {
    test('番組表を待たずに局だけ取り込む', async () => {
        expect(await syncServicesOnly()).toBe(1);

        const rows = database().query('SELECT id, name, type FROM services').all();
        // 全角英数は取り込むときに直す。他の画面と字面がずれると別の局に見える
        expect(rows).toEqual([{ id: 3239123608, name: 'TOKYO MX', type: 'GR' }]);

        // 番組表は取りに行っていないこと。ここが本題で、
        // 番組表ごと取っていた頃は mirakc が集め終わるまで局も出せなかった
        expect(asked).toEqual(['/api/services']);
        expect(database().query('SELECT COUNT(*) AS n FROM programs').get()).toEqual({ n: 0 });
    });

    test('何度呼んでも増えない', async () => {
        await syncServicesOnly();
        expect(database().query('SELECT COUNT(*) AS n FROM services').get()).toEqual({ n: 1 });
    });
});

/**
 * mirakc から消えた局の片付け。
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
        offered = [service(3239123609, '別の局')];
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
        offered = [service(3239123608, 'ＴＯＫＹＯ　ＭＸ')];
        await syncServicesOnly();
        seed(3239123608);

        /*
         * mirakc は起動直後や不調で空を返すことがある。それを「全部消えた」と
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
