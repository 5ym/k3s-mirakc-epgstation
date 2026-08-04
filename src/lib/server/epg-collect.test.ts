import { describe, expect, test } from 'bun:test';
import type { AgentChannel } from './tuner';

/**
 * どのチャンネルを集めに行くか。
 *
 * **ここが実機で暴走した。** 番組表が7日先まで埋まっているのに、30分ごとの
 * 周回で毎回ほぼ全チャンネルが選ばれ、1本ぶんの上限まで開きっぱなしに
 * なっていた ([config.ts](config.ts) の epgChannelTimeout)。
 */
const { config } = await import('./config');
const { lastOf, pickChannels, reachOf } = await import('./epg-collect');
const { serviceKey } = await import('./tuner');

const NETWORK = 32391;

function channel(name: string, services: number[]): AgentChannel {
    return {
        type: 'GR',
        channel: name,
        networkId: NETWORK,
        transportStreamId: NETWORK,
        remoteControlKeyId: 9,
        services: services.map((serviceId) => ({ serviceId, serviceType: 1, name: `局${serviceId}` })),
    } as AgentChannel;
}

describe('どこまで埋まっているか', () => {
    const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
    const WEEK = NOW + 7 * 24 * 3600_000;

    test('乗っている局のうち、いちばん薄いものに合わせる', () => {
        const reach = new Map([
            [serviceKey(NETWORK, 23608), WEEK],
            [serviceKey(NETWORK, 23610), NOW],
        ]);

        expect(reachOf(reach, channel('T16', [23608, 23610]))).toBe(NOW);
    });

    /*
     * エージェントは TS に居る全部の局を返すが、denpa は映像の入っていない局を
     * 落とす (`epg.syncServices`)。数に入れていた頃は「0 まで埋まっている =
     * いちばん薄い」と読んで、データ放送を積んでいる地上波が丸ごと毎周回の
     * 対象になっていた
     */
    test('番組表に出てこない局は数えない', () => {
        const reach = new Map([[serviceKey(NETWORK, 23608), WEEK]]);

        // 23611 はデータ放送。denpa の services には居ない
        expect(reachOf(reach, channel('T16', [23608, 23611]))).toBe(WEEK);
    });

    test('1局も知らないチャンネルはまっさら扱い', () => {
        expect(reachOf(new Map(), channel('T16', [23608]))).toBe(0);
    });
});

describe('pickChannels', () => {
    const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
    /** 番組表が薄い (まっさら) チャンネル */
    const thin = () => 0;
    /** 7日先まで埋まっているチャンネル */
    const full = () => NOW + 7 * 24 * 3600_000;

    test('薄いチャンネルから先に行く', () => {
        const channels = [channel('T16', [1]), channel('T25', [2])];
        const reach = new Map([
            ['T16', NOW + 5 * 24 * 3600_000],
            ['T25', NOW],
        ]);

        expect(
            pickChannels(
                channels,
                (c) => reach.get(c.channel) ?? 0,
                () => 0,
                NOW,
            ).map((c) => c.channel),
        ).toEqual(['T25', 'T16']);
    });

    test('埋まっていて、行ったばかりのチャンネルは行かない', () => {
        expect(pickChannels([channel('T16', [1])], full, () => NOW, NOW)).toEqual([]);
    });

    /*
     * **実機に受信できない CS が 24 局残っていた。** 開いても EIT が1件も来ない
     * ので永久に薄いままで、「薄いから行く」だけで選んでいた頃は周回のたびに
     * 選ばれ、上限まで開きっぱなしになっていた
     */
    test('薄くても、行った直後は行き直さない', () => {
        const justNow = NOW - config.epgChannelRetry + 1;

        expect(pickChannels([channel('CS08', [55])], thin, () => justNow, NOW)).toEqual([]);
    });

    test('休ませる時間が過ぎたら、薄いところへは行き直す', () => {
        const before = NOW - config.epgChannelRetry - 1;

        expect(pickChannels([channel('CS08', [55])], thin, () => before, NOW).map((c) => c.channel)).toEqual([
            'CS08',
        ]);
    });

    test('埋まっていても、しばらく行っていなければ行く。当日ぶんは直前まで書き換わる', () => {
        const stale = NOW - config.epgChannelInterval - 1;

        expect(pickChannels([channel('T16', [1])], full, () => stale, NOW).map((c) => c.channel)).toEqual([
            'T16',
        ]);
    });
});

/*
 * **最後に集めた時刻は局から引く。**
 *
 * `services.channel` に入るのは「最後に取り込んだときの枠の名前」1つだけなので、
 * 同じ TS を指す枠が2つあると片方が必ず「一度も集めていない」ことになる。
 * 実機の BS がまさにそれで、9枠が永久にまっさらに見えて周回のたびに開かれていた。
 */
describe('最後に集めた時刻', () => {
    const AT = Date.UTC(2026, 7, 4, 3, 0, 0);

    test('乗っている局のうち、いちばん新しいものを採る', () => {
        const perService = new Map([
            [serviceKey(NETWORK, 101), AT - 60_000],
            [serviceKey(NETWORK, 102), AT],
        ]);

        expect(lastOf(perService, channel('BS01_0', [101, 102]))).toBe(AT);
    });

    test('同じ局を指す別の枠からでも、同じ時刻が出る', () => {
        const perService = new Map([[serviceKey(NETWORK, 101), AT]]);

        expect(lastOf(perService, channel('BS01_3', [101]))).toBe(AT);
    });

    test('1件も入っていなければ「まっさら」', () => {
        expect(lastOf(new Map(), channel('BS01_0', [101]))).toBe(0);
    });
});
