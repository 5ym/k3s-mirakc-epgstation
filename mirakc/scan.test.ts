import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nitSection, packetize, sdtSection } from '../src/lib/ts/synth';
import { channelEntry, channelsFor, readServices, render, Scanner } from './scan';

/**
 * チューナーの代わりに、組み立てた TS を吐くだけのコマンドを使う。
 * 選局から設定の組み立てまで、実際に子プロセスを回して確かめる。
 */

/** NIT と SDT だけの TS。チューナーが吐くものの代わり */
function writeStream(path: string, services: [number, number][]): void {
    const data = [
        // 頭に無関係なパケットを混ぜておく。すぐには揃わない状況にするため
        ...packetize(0x0100, sdtSection(0x0408, 0x0004, services)),
        ...packetize(0x0010, nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]])),
        ...packetize(0x0011, sdtSection(0x0408, 0x0004, services), 3),
    ];
    writeFileSync(path, Uint8Array.from(data));
}

/** その文字列を含むプロセスの数。孫が残っていないかを見るのに使う */
function running(needle: string): number {
    let count = 0;
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            if (readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(needle)) count++;
        } catch {
            // 見ている間に終わったもの
        }
    }
    return count;
}

function fakeTuner(services: [number, number][] = [[1024, 0x01]]): string {
    const path = join(mkdtempSync(join(tmpdir(), 'denpa-scan-')), 'stream.ts');
    writeStream(path, services);
    return path;
}

describe('選局するチャンネル', () => {
    test('地上波は 13〜62ch', () => {
        const channels = channelsFor('GR');
        expect(channels[0]).toBe('T13');
        expect(channels.at(-1)).toBe('T62');
        expect(channels).toHaveLength(50);
    });

    test('BSは1chあたり4スロット', () => {
        const channels = channelsFor('BS');
        expect(channels.slice(0, 5)).toEqual(['BS01_0', 'BS01_1', 'BS01_2', 'BS01_3', 'BS02_0']);
        expect(channels).toHaveLength(23 * 4);
    });

    test('CSは02chから', () => {
        expect(channelsFor('CS')[0]).toBe('CS02');
    });

    test('範囲を広げても放送に無いチャンネルは足さない', () => {
        expect(channelsFor('GR', 1, 999)[0]).toBe('T13');
        expect(channelsFor('GR', 1, 999).at(-1)).toBe('T62');
        expect(channelsFor('GR', 20, 22)).toEqual(['T20', 'T21', 'T22']);
    });
});

describe('チューナーコマンド', () => {
    test('mirakc のテンプレートを埋める', () => {
        expect(
            render('recisdb tune --device /dev/dvb/adapter0/frontend0 -c {{{channel}}} -', 'T27', 'GR'),
        ).toBe('recisdb tune --device /dev/dvb/adapter0/frontend0 -c T27 -');
    });

    test('種別と長さも埋める', () => {
        expect(render('x {{channel_type}} {{{duration}}}', 'T27', 'GR')).toBe('x GR -');
    });

    test('知らない差し込みは空にする', () => {
        expect(render('a {{{extra_args}}} b', 'T27', 'GR')).toBe('a  b');
    });
});

describe('設定の組み立て', () => {
    test('見つけたサービスを並べる', () => {
        const entry = channelEntry('GR', 'T27', [
            { serviceId: 1032, serviceType: 1, networkId: 1, transportStreamId: 1, remoteControlKeyId: 9 },
            { serviceId: 1024, serviceType: 1, networkId: 1, transportStreamId: 1, remoteControlKeyId: 9 },
        ]);
        expect(entry).toEqual({ name: 'T27', type: 'GR', channel: 'T27', services: [1024, 1032] });
    });
});

describe('1チャンネルの読み取り', () => {
    test('チューナーの出力からサービスを読む', async () => {
        const path = fakeTuner([
            [1024, 0x01],
            [1025, 0x01],
        ]);
        const { services, error } = await readServices(`cat ${path}`, 5000);
        expect(error).toBeNull();
        expect(services?.map((s) => s.serviceId)).toEqual([1024, 1025]);
        expect(services?.[0].remoteControlKeyId).toBe(6);
    });

    test('何も出てこなければ受信できていない', async () => {
        const { services, error } = await readServices('true', 5000);
        expect(services).toBeNull();
        expect(error).toBe('受信できませんでした');
    });

    test('片方しか来なければ諦める', async () => {
        // SDT だけ。どのネットワークのものか分からないので設定には書けない
        const path = join(mkdtempSync(join(tmpdir(), 'denpa-scan-')), 'half.ts');
        writeFileSync(path, packetize(0x0011, sdtSection(0x0408, 0x0004, [[1024, 0x01]])));
        const { services, error, signal } = await readServices(`cat ${path}; sleep 5`, 2000);
        expect(services).toBeNull();
        // 「受信できませんでした」で片付けない。電波は来ているので疑うところが違う
        expect(signal).toBe(true);
        expect(error).toBe('NIT が来ませんでした');
    });

    test('失敗した理由を持ち帰る', async () => {
        // recisdb は「デバイスが使用中」などを stderr に書く。捨てると原因が分からない
        const { error, signal } = await readServices('echo "Cannot open device" >&2; exit 1', 5000);
        expect(signal).toBe(false);
        expect(error).toBe('受信できませんでした (Cannot open device)');
    });

    test('パイプラインでも孫プロセスを残さない', async () => {
        /*
         * 掴んだままにするとチューナーが空かず、以降のチャンネルが全部
         * 「受信できませんでした」になる。sh を1つ殺すだけでは足りない
         */
        const path = fakeTuner();
        // /proc から見分けるため、待つ側は名前がユニークなスクリプトにする
        const hold = join(mkdtempSync(join(tmpdir(), 'denpa-hold-')), 'hold.sh');
        writeFileSync(hold, 'sleep 300\n');

        const { error } = await readServices(`{ cat ${path}; sh ${hold}; } | cat`, 5000);
        expect(error).toBeNull();
        // 揃った時点で打ち切るので、この時点ではまだ sleep している最中のはず
        expect(running(hold)).toBe(0);
    });

    test('揃った時点で打ち切る', async () => {
        // 居る局で毎回20秒待っていたら総当たりが終わらない
        const path = fakeTuner();
        const started = Bun.nanoseconds();
        const { error } = await readServices(`cat ${path}; sleep 30`, 30_000);
        expect(error).toBeNull();
        expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(10);
    });
});

describe('総当たり', () => {
    test('チャンネル定義を組み立てる', async () => {
        const path = fakeTuner();
        const found = await new Scanner([{ name: 'a', types: ['GR'], command: `cat ${path}` }]).run([
            ['GR', ['T20', 'T21']],
        ]);
        expect(found.map((c) => c.channel)).toEqual(['T20', 'T21']);
        expect(found[0].services).toEqual([1024]);
    });

    test('対応するチューナーが無い種別は飛ばす', async () => {
        const lines: (string | undefined)[] = [];
        const path = fakeTuner();
        const scanner = new Scanner([{ name: 'a', types: ['GR'], command: `cat ${path}` }], (p) =>
            lines.push(p.line),
        );
        expect(await scanner.run([['BS', ['BS01_0']]])).toEqual([]);
        expect(lines).toContain('BS: 対応するチューナーがありません');
    });

    test('無効なチューナーは使わない', async () => {
        const path = fakeTuner();
        const found = await new Scanner([
            { name: 'a', types: ['GR'], command: `cat ${path}`, disabled: true },
        ]).run([['GR', ['T20']]]);
        expect(found).toEqual([]);
    });

    test('電波は来たのに揃わなかったチャンネルはもう一度試す', async () => {
        // NIT は 10 秒に1回。選局が落ち着くのが遅れると1回も入らないことがある
        const half = join(mkdtempSync(join(tmpdir(), 'denpa-scan-')), 'half.ts');
        writeFileSync(half, packetize(0x0011, sdtSection(0x0408, 0x0004, [[1024, 0x01]])));

        const lines: (string | undefined)[] = [];
        await new Scanner([{ name: 'a', types: ['GR'], command: `cat ${half}` }], (p) =>
            lines.push(p.line),
        ).run([['GR', ['T20']]]);
        expect(lines).toContain('GR: 1ch をもう一度試します');

        // 何も来なかったチャンネルは回し直さない (総当たりが倍の時間になる)
        const quiet: (string | undefined)[] = [];
        await new Scanner([{ name: 'a', types: ['GR'], command: 'true' }], (p) => quiet.push(p.line)).run([
            ['GR', ['T20']],
        ]);
        expect(quiet.some((line) => line?.includes('もう一度'))).toBe(false);
    });

    test('受信できなかったチャンネルは残さない', async () => {
        const found = await new Scanner([{ name: 'a', types: ['GR'], command: 'true' }]).run([
            ['GR', ['T20', 'T21']],
        ]);
        expect(found).toEqual([]);
    });
});
