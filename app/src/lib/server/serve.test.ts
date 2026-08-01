import { describe, expect, test } from 'bun:test';
import { contentDisposition } from './serve';

describe('ダウンロード時のファイル名', () => {
    test('日本語は filename* で渡し、ASCII の控えも並べる', () => {
        // 付けないと /api/recordings/12/file が「file」として落ちてくる
        const value = contentDisposition('テストアニメ - 2026-08-01 - 決戦.mkv', true);
        expect(value).toStartWith('attachment; ');
        expect(value).toContain("filename*=UTF-8''");
        expect(value).toContain(encodeURIComponent('テストアニメ - 2026-08-01 - 決戦.mkv'));
        // 読めない相手にも拡張子だけは伝わるようにする
        expect(value).toContain('.mkv"');
    });

    test('ASCII の控えに引用符やバックスラッシュを残さない', () => {
        // ヘッダの引用が壊れると、名前どころか応答ごと読めなくなる
        const value = contentDisposition('a"b\\c.mkv', true);
        expect(value).toContain('filename="a_b_c.mkv"');
    });

    test('添付にしないときは inline', () => {
        // プレイヤーに渡すときは inline のほうが素直に開く
        expect(contentDisposition('a.mkv', false)).toStartWith('inline; ');
    });
});
