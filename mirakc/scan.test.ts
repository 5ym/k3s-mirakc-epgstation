import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelEntry, channelsFor, readServices, render, Scanner } from './scan';
import { nitSection, packetize, sdtSection } from './tsinfo.test';

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
        const { services, error } = await readServices(`cat ${path}; sleep 5`, 2000);
        expect(services).toBeNull();
        expect(error).toBe('受信できませんでした');
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

    test('受信できなかったチャンネルは残さない', async () => {
        const found = await new Scanner([{ name: 'a', types: ['GR'], command: 'true' }]).run([
            ['GR', ['T20', 'T21']],
        ]);
        expect(found).toEqual([]);
    });
});
