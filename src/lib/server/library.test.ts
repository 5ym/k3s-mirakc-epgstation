import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 保存先での名前の付け方。
 *
 * 環境変数ではなく設定そのものを書き換えている (理由は files.test.ts と同じ)。
 */
const { config } = await import('./config');
config.libraryDir = mkdtempSync(join(tmpdir(), 'denpa-lib-'));

const { libraryPath } = await import('./library');

/** 2026-08-03 22:30 開始の録画 */
function recording(overrides: { library_path?: string | null } = {}) {
    return {
        id: 39,
        series: '番組',
        subtitle: '',
        start_at: new Date(2026, 7, 3, 22, 30).getTime(),
        ...overrides,
    };
}

const PLAIN = '番組/Season 2026/番組 - 2026-08-03 - 2230.mkv';
const WITH_ID = '番組/Season 2026/番組 - 2026-08-03 - 2230 [39].mkv';

function place(rel: string): string {
    const path = join(config.libraryDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'x');
    return path;
}

describe('保存先での名前', () => {
    test('空いていれば素の名前', () => {
        expect(libraryPath(recording(), '.mkv')).toBe(join(config.libraryDir, PLAIN));
    });

    /*
     * **焼き直しで名前が入れ替わらないこと。**
     *
     * `existsSync` だけで決めていた頃は、焼き直すたびに素の名前と `[39]` 付きを
     * 行き来していた (置き換えたあと古いほうを消すので、次はまた素の名前が空く)。
     * 中身は無事だが、プレイヤー側の見え方が毎回崩れる
     */
    test('いま置いてある自分のファイルは衝突ではない', () => {
        const mine = place(PLAIN);
        expect(libraryPath(recording({ library_path: mine }), '.mkv')).toBe(mine);
    });

    test('別の録画のファイルとぶつかったら録画IDを足す', () => {
        place(PLAIN);
        // 自分はまだどこにも置いていない (初回) / 置き場が違う
        expect(libraryPath(recording({ library_path: null }), '.mkv')).toBe(join(config.libraryDir, WITH_ID));
    });
});
