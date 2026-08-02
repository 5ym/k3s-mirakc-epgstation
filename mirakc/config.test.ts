import { describe, expect, test } from 'bun:test';
import { parseConfig, renderChannels, replaceChannels } from './config';
import type { ChannelEntry } from './scan';

const CHANNELS: ChannelEntry[] = [
    { name: 'T20', type: 'GR', channel: 'T20', services: [1024, 1025] },
    { name: 'BS01_0', type: 'BS', channel: 'BS01_0', services: [] },
];

const CONFIG = `# 初期設定
epg:
    cache-dir: /var/lib/mirakc/epg

channels: []

# チューナーは繋いである機材の話なので、スキャンでは分からない
tuners:
    - name: adapter0
      types: [GR]
      command: recisdb tune --channel {{{channel}}} -
`;

describe('チャンネルの書き出し', () => {
    test('ブロック形式で書く', () => {
        expect(renderChannels(CHANNELS)).toBe(
            'channels:\n' +
                '    - name: T20\n      type: GR\n      channel: T20\n      services: [1024, 1025]\n' +
                '    - name: BS01_0\n      type: BS\n      channel: BS01_0\n',
        );
    });

    test('1件も無ければ空の配列にする', () => {
        // mirakc は空でも起動できる。キーごと消すと読めなくなる
        expect(renderChannels([])).toBe('channels: []\n');
    });

    test('書いたものを mirakc と同じ解釈で読み返せる', () => {
        const parsed = parseConfig(renderChannels(CHANNELS));
        expect(parsed.channels).toEqual([
            { name: 'T20', type: 'GR', channel: 'T20', services: [1024, 1025] },
            // services を省くと mirakc は「見つかったもの全部」として扱う
            { name: 'BS01_0', type: 'BS', channel: 'BS01_0' },
        ] as never);
    });
});

describe('設定の差し替え', () => {
    test('channels だけ入れ替える', () => {
        const updated = replaceChannels(CONFIG, CHANNELS);
        expect(parseConfig(updated).channels).toHaveLength(2);
        expect(parseConfig(updated).tuners?.[0].name).toBe('adapter0');
    });

    test('コメントも書式も残す', () => {
        // 読んで書き直すとコメントが消える。手で編集する設定なので残す
        const updated = replaceChannels(CONFIG, CHANNELS);
        expect(updated).toContain('# 初期設定');
        expect(updated).toContain('# チューナーは繋いである機材の話なので');
        expect(updated).toContain('command: recisdb tune --channel {{{channel}}} -');
    });

    test('何度やっても同じ形になる', () => {
        const once = replaceChannels(CONFIG, CHANNELS);
        expect(replaceChannels(once, CHANNELS)).toBe(once);
    });

    test('複数行で書かれていた channels も丸ごと差し替える', () => {
        const before = replaceChannels(CONFIG, [
            { name: 'T13', type: 'GR', channel: 'T13', services: [1] },
            { name: 'T14', type: 'GR', channel: 'T14', services: [2] },
            { name: 'T15', type: 'GR', channel: 'T15', services: [3] },
        ]);
        const after = replaceChannels(before, CHANNELS);
        expect(parseConfig(after).channels?.map((c) => c.channel)).toEqual(['T20', 'BS01_0']);
        expect(after).not.toContain('T13');
    });

    test('channels が無い設定にも足せる', () => {
        const updated = replaceChannels('epg:\n    cache-dir: /tmp\n', CHANNELS);
        expect(parseConfig(updated).channels).toHaveLength(2);
    });
});

describe('探した種別だけ入れ替える', () => {
    /*
     * 地上波だけスキャンしたときに全部を置き換えると、BS と CS が設定から消える。
     * 実際に消して、BSの予約が録れなくなった。agent.ts の saveChannels と同じ
     * 組み立てをここで確かめる (mirakc を起こさずに見られるのはこの形まで)
     */
    const before = `channels:
    - name: T16
      type: GR
      channel: T16
      services: [23608]
    - name: BS15_0
      type: BS
      channel: BS15_0
      services: [211]

tuners:
    - name: adapter0
      types: [GR, BS]
      command: recisdb tune --channel {{{channel}}} -
`;

    test('地上波を探し直しても BS は残る', () => {
        const kept = (parseConfig(before).channels ?? []).filter((c) => !['GR'].includes(c.type));
        const found = [{ name: 'T21', type: 'GR' as const, channel: 'T21', services: [1064] }];
        const after = replaceChannels(before, [...kept, ...found]);

        const channels = parseConfig(after).channels ?? [];
        expect(channels.map((c) => c.channel)).toEqual(['BS15_0', 'T21']);
        // チューナーの定義は触らない
        expect(parseConfig(after).tuners).toHaveLength(1);
    });

    test('同じ種別は入れ替わる', () => {
        const kept = (parseConfig(before).channels ?? []).filter((c) => !['GR', 'BS'].includes(c.type));
        expect(kept).toHaveLength(0);
    });
});
