import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTuner } from './tuner';

/**
 * CM検出のロゴを、録画より先に覚えておくところ。
 *
 * 見るのは**誰を掴みに行くか**。実際に覚えるのは logoframe の仕事で、手元では
 * 回せない (実機で確かめる)。掴む相手を間違えると、要らない局のためにチューナーを
 * 数分ずつ潰すことになるので、そこだけは押さえておく。
 *
 * **DB には触らない。** 単体テストは1つのプロセスで走り、DB の繋ぎ先は最初に
 * 開いたものが使い回される。ここで開くと他のファイルが数えている行に混ざる
 * (実際に混ぜて3件落とした)。決まりのほうを `pending` に分けてあるので、
 * 行を渡すだけで試せる。
 */
const work = mkdtempSync(join(tmpdir(), 'denpa-learn-'));
const { config } = await import('./config');
config.jlsLogoDir = join(work, 'jls');

const { learned, openable, pending, ridingFirst, stations } = await import('./logo-learn');

function service(id: number, name: string, networkId = 32391) {
    return {
        id,
        service_id: id % 100000,
        network_id: networkId,
        name,
        type: 'GR' as const,
        channel: 'T13',
    };
}

/** logoframe が覚えたことにする */
function remember(id: number) {
    const repo = join(config.jlsLogoDir, String(id));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, `${id}.lgd`), 'dummy');
}

describe('覚えたかどうか', () => {
    test('.lgd があれば覚えている', () => {
        remember(1);

        expect(learned(1)).toBe(true);
    });

    test('置き場が無ければ覚えていない', () => {
        expect(learned(2)).toBe(false);
    });

    test('.lgd 以外しか無ければ覚えていない', () => {
        // logoframe は途中で落ちても作業ファイルを残す。それを「覚えた」と
        // 数えると、二度と覚え直さない
        const repo = join(config.jlsLogoDir, '3');
        mkdirSync(repo, { recursive: true });
        writeFileSync(join(repo, 'frames.txt'), '');

        expect(learned(3)).toBe(false);
    });
});

describe('誰を掴みに行くか', () => {
    test('覚えている局は掴みに行かない', () => {
        remember(10);

        const targets = pending([service(10, '覚えた局'), service(11, 'まだの局')]);

        expect(targets.map((target) => target.id)).toEqual([11]);
    });

    test('渡された順のまま返す', () => {
        // 並べ替えは SQL 側 (リモコン番号の順)。ここで崩さない
        const targets = pending([service(21, 'ろ'), service(20, 'い'), service(22, 'は')]);

        expect(targets.map((target) => target.id)).toEqual([21, 20, 22]);
    });
});

/*
 * 放送局はサブチャンネルの枠を常時流していて、マルチ編成をしていない間は
 * 本チャンネルと同じ絵が出ている。SDT の局名も同じなので、実機では
 * 「TOKYO MX1」が2つ、「フジテレビ」「テレビ朝日」が3つずつ並んでいた
 */
describe('同じ絵を映している局を束ねる', () => {
    test('局名が同じものは1つにする', () => {
        const rows = [
            service(3239123608, 'TOKYO MX1'),
            service(3239123609, 'TOKYO MX1'),
            service(3239123610, 'TOKYO MX2'),
        ];

        expect(stations(rows).map((row) => row.id)).toEqual([3239123608, 3239123610]);
    });

    test('もう覚えている局を代表にする', () => {
        remember(31);
        const rows = [service(30, 'テレ東'), service(31, 'テレ東')];

        expect(stations(rows).map((row) => row.id)).toEqual([31]);
    });

    test('ネットワークが違えば別の局。たまたま同名なだけのことがある', () => {
        const rows = [service(40, 'サンテレビ', 32391), service(41, 'サンテレビ', 32400)];

        expect(stations(rows).map((row) => row.id)).toEqual([40, 41]);
    });
});

/*
 * **開いている相手が居れば只で乗れる。**
 *
 * エージェントは同じ物理チャンネルの読み手を相乗りさせるので、録画中の
 * チャンネルならチューナーは増えない。空きだけを見ていた頃は、**只で
 * 覚えられる局を見送って**いた。
 */
describe('掴みに行けるか', () => {
    const tuner = (
        types: ('GR' | 'BS' | 'CS')[],
        channel: { type: 'GR' | 'BS' | 'CS'; channel: string } | null,
    ): AgentTuner =>
        ({
            index: 0,
            name: 'adapter',
            types,
            disabled: false,
            device: null,
            lnb: null,
            command: null,
            channel,
            users: [],
            pid: null,
            error: null,
        }) satisfies AgentTuner;

    const target = (type: 'GR' | 'BS' | 'CS', channel: string) => ({ type, channel });

    test('全部塞がっていても、そのチャンネルが開いていれば行く', () => {
        const tuners = [tuner(['GR'], { type: 'GR', channel: 'T21' })];

        expect(openable(tuners, target('GR', 'T21'))).toBe(true);
    });

    test('全部塞がっていて、別のチャンネルなら行かない', () => {
        const tuners = [tuner(['GR'], { type: 'GR', channel: 'T21' })];

        expect(openable(tuners, target('GR', 'T27'))).toBe(false);
    });

    test('空いているチューナーがあれば行く', () => {
        const tuners = [tuner(['GR'], { type: 'GR', channel: 'T21' }), tuner(['GR'], null)];

        expect(openable(tuners, target('GR', 'T27'))).toBe(true);
    });

    test('空きはあっても種別が違えば行かない。衛星の空きは地上波の役に立たない', () => {
        const tuners = [tuner(['BS', 'CS'], null)];

        expect(openable(tuners, target('GR', 'T27'))).toBe(false);
    });

    /*
     * 1局に5分かかるので、順番を間違えると只で覚えられたはずの録画中の局が
     * 終わってしまう
     */
    test('只で乗れるものを先に回す', () => {
        const tuners = [tuner(['GR'], { type: 'GR', channel: 'T27' }), tuner(['GR'], null)];
        const targets = [target('GR', 'T21'), target('GR', 'T27'), target('GR', 'T25')];

        expect(ridingFirst(tuners, targets).map((t) => t.channel)).toEqual(['T27', 'T21', 'T25']);
    });
});
