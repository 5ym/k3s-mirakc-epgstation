import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nitSection, packetize, sdtSection } from '../src/lib/ts/synth';
import { channelEntry } from './channels';
import { channelsFor, readServices, Scanner } from './scan';
import { TunerPool } from './tuners';

/** NIT と SDT だけの TS。チューナーが吐くものの代わり */
function stream(services: [number, number, string?][], half = false): Uint8Array {
    return Uint8Array.from([
        // 頭に無関係なパケットを混ぜておく。すぐには揃わない状況にするため
        ...packetize(0x0100, sdtSection(0x0408, 0x0004, services)),
        ...(half ? [] : [...packetize(0x0010, nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]))]),
        ...packetize(0x0011, sdtSection(0x0408, 0x0004, services), 3),
    ]);
}

/** バイト列をそのまま返す読み口。選局の代わり */
function fromBytes(data: Uint8Array, keepOpen = false): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(data);
            if (!keepOpen) controller.close();
        },
    });
}

/**
 * その TS を吐くチューナーを1本だけ持つプール。
 *
 * `hold` を付けると流し終えても閉じない (本物の選局は止めるまで流れ続ける)。
 * 付けないと選局が終わったことになるので、待ち時間を使い切らずに済む
 */
function tunerPool(data: Uint8Array, hold = true): TunerPool {
    const path = join(mkdtempSync(join(tmpdir(), 'denpa-scan-')), 'stream.ts');
    writeFileSync(path, data);
    const command = hold ? `cat ${path}; sleep 30` : `cat ${path}`;
    return new TunerPool([{ name: 'a', types: ['GR'], command }]);
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

describe('チャンネル定義の組み立て', () => {
    test('見つけたサービスを局名ごと並べる', () => {
        const entry = channelEntry('GR', 'T27', [
            {
                serviceId: 1032,
                serviceType: 1,
                name: 'TOKYO MX2',
                networkId: 32391,
                transportStreamId: 23608,
                remoteControlKeyId: 9,
            },
            {
                serviceId: 1024,
                serviceType: 1,
                name: 'TOKYO MX1',
                networkId: 32391,
                transportStreamId: 23608,
                remoteControlKeyId: 9,
            },
        ]);
        expect(entry).toEqual({
            type: 'GR',
            channel: 'T27',
            networkId: 32391,
            transportStreamId: 23608,
            remoteControlKeyId: 9,
            services: [
                { serviceId: 1024, serviceType: 1, name: 'TOKYO MX1' },
                { serviceId: 1032, serviceType: 1, name: 'TOKYO MX2' },
            ],
        });
    });
});

describe('1チャンネルの読み取り', () => {
    test('流れてきた TS からサービスを読む', async () => {
        const { services, error } = await readServices(
            fromBytes(
                stream([
                    [1024, 0x01, 'TOKYO MX1'],
                    [1025, 0x01],
                ]),
            ),
            5000,
        );
        expect(error).toBeNull();
        expect(services?.map((s) => s.serviceId)).toEqual([1024, 1025]);
        expect(services?.[0].name).toBe('TOKYO MX1');
        expect(services?.[0].remoteControlKeyId).toBe(6);
    });

    test('何も出てこなければ受信できていない', async () => {
        const { services, error } = await readServices(fromBytes(new Uint8Array(0)), 500);
        expect(services).toBeNull();
        expect(error).toBe('受信できませんでした');
    });

    test('片方しか来なければ諦める', async () => {
        // SDT だけ。どのネットワークのものか分からないので設定には書けない
        const { services, error, signal } = await readServices(
            fromBytes(stream([[1024, 0x01]], true), true),
            500,
        );
        expect(services).toBeNull();
        // 「受信できませんでした」で片付けない。電波は来ているので疑うところが違う
        expect(signal).toBe(true);
        expect(error).toBe('NIT が来ませんでした');
    });

    test('失敗した理由を持ち帰る', async () => {
        // recisdb は「デバイスが使用中」などを stderr に書く。捨てると原因が分からない
        const pool = new TunerPool([
            { name: 'a', types: ['GR'], command: 'echo "Cannot open device" >&2; exit 1' },
        ]);
        const opened = pool.open({ type: 'GR', channel: 'T21', priority: 1, use: 'scan' });
        const { error, signal } = await readServices(opened, 5000);
        expect(signal).toBe(false);
        expect(error).toContain('Cannot open device');
        pool.closeAll();
    });

    test('揃った時点で打ち切る', async () => {
        // 居る局で毎回30秒待っていたら総当たりが終わらない
        const pool = tunerPool(stream([[1024, 0x01]]));
        const started = Bun.nanoseconds();
        const { error } = await readServices(
            pool.open({ type: 'GR', channel: 'T21', priority: 1, use: 'scan' }),
            30_000,
        );
        expect(error).toBeNull();
        expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(10);
        pool.closeAll();
    });
});

describe('総当たり', () => {
    test('チャンネル定義を組み立てる', async () => {
        const pool = tunerPool(stream([[1024, 0x01, 'TOKYO MX1']]));
        const found = await new Scanner(pool).run([['GR', ['T20', 'T21']]]);
        expect(found.map((c) => c.channel)).toEqual(['T20', 'T21']);
        expect(found[0].services).toEqual([{ serviceId: 1024, serviceType: 1, name: 'TOKYO MX1' }]);
        pool.closeAll();
    });

    test('対応するチューナーが無い種別は飛ばす', async () => {
        const lines: (string | undefined)[] = [];
        const pool = tunerPool(stream([[1024, 0x01]]));
        const scanner = new Scanner(pool, (p) => lines.push(p.line));
        expect(await scanner.run([['BS', ['BS01_0']]])).toEqual([]);
        expect(lines).toContain('BS: 対応するチューナーがありません');
        pool.closeAll();
    });

    test('無効なチューナーは使わない', async () => {
        const pool = new TunerPool([{ name: 'a', types: ['GR'], command: 'true', disabled: true }]);
        expect(await new Scanner(pool).run([['GR', ['T20']]])).toEqual([]);
        pool.closeAll();
    });

    test('電波は来たのに揃わなかったチャンネルはもう一度試す', async () => {
        // NIT は 10 秒に1回。選局が落ち着くのが遅れると1回も入らないことがある
        const lines: (string | undefined)[] = [];
        const half = tunerPool(stream([[1024, 0x01]], true), false);
        await new Scanner(half, (p) => lines.push(p.line)).run([['GR', ['T20']]]);
        expect(lines).toContain('GR: 1ch をもう一度試します');
        half.closeAll();

        // 何も来なかったチャンネルは回し直さない (総当たりが倍の時間になる)
        const quiet: (string | undefined)[] = [];
        const silent = new TunerPool([{ name: 'a', types: ['GR'], command: 'true' }]);
        await new Scanner(silent, (p) => quiet.push(p.line)).run([['GR', ['T20']]]);
        expect(quiet.some((line) => line?.includes('もう一度'))).toBe(false);
        silent.closeAll();
    });

    test('受信できなかったチャンネルは残さない', async () => {
        const pool = new TunerPool([{ name: 'a', types: ['GR'], command: 'true' }]);
        expect(await new Scanner(pool).run([['GR', ['T20', 'T21']]])).toEqual([]);
        pool.closeAll();
    });
});
