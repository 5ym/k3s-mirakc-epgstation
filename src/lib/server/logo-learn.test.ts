import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const { learned, pending } = await import('./logo-learn');

function service(id: number, name: string) {
    return { id, service_id: id % 100000, name, type: 'GR' as const, channel: 'T13' };
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
