import { describe, expect, test } from 'bun:test';
import { nitSection, packetize, sdtSection } from '../ts/synth';
import { channelEntry, channelsFor, readServices, twinOf } from './scan';
import type { AgentChannel } from './tuner';

/**
 * 総当たりそのもの (`Scanner`) はここでは試さない。**エージェントに選局を
 * 頼む形**になったので、相手が居ないと動かない。通しで見ているのは
 * `tests/e2e/16-scan.spec.ts` で、本物の総当たりが偽の放送に当たっている。
 */

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

/**
 * 衛星は「無い相対番号」を指すと**先頭の TS が返ってくる** (断ってはくれない)。
 * 実機では 35 枠のうち 9 枠がその写しだった。
 */
describe('同じ TS を指している枠', () => {
    const entry = (channel: string, tsid: number): AgentChannel => ({
        type: 'BS',
        channel,
        networkId: 4,
        transportStreamId: tsid,
        remoteControlKeyId: null,
        services: [{ serviceId: 151, serviceType: 1, name: 'BS朝日1' }],
    });

    test('先に見つけたほうの名前を返す', () => {
        const found = [entry('BS01_0', 16400), entry('BS01_1', 16401)];

        expect(twinOf(found, entry('BS01_3', 16400))).toBe('BS01_0');
        expect(twinOf(found, entry('BS01_2', 16402))).toBeNull();
    });

    test('種別が違えば別物。TSID は種別をまたいで一意ではない', () => {
        const found = [entry('BS01_0', 16400)];
        const cs = { ...entry('CS02', 16400), type: 'CS' as const };

        expect(twinOf(found, cs)).toBeNull();
    });

    test('TSID が分からないものは落とさない', () => {
        // 読めなかったものまで「写し」として捨てると、その中継が丸ごと消える
        const found = [entry('BS01_0', 0)];

        expect(twinOf(found, entry('BS01_1', 0))).toBeNull();
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
        // 選局が落ちた理由 (「デバイスが使用中」など) を捨てると原因が分からない
        const failing = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.error(new Error('Cannot open device'));
            },
        });
        const { error, signal } = await readServices(failing, 5000);
        expect(signal).toBe(false);
        expect(error).toContain('Cannot open device');
    });

    test('揃った時点で打ち切る', async () => {
        // 居る局で毎回30秒待っていたら総当たりが終わらない。**閉じない読み口**で試す
        const started = Bun.nanoseconds();
        const { error } = await readServices(fromBytes(stream([[1024, 0x01]]), true), 30_000);
        expect(error).toBeNull();
        expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(10);
    });
});
