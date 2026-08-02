import { describe, expect, test } from 'bun:test';
import { encodeSource, isRawTs } from './source';

describe('エンコードの元', () => {
    test('生TSがあればそれ', () => {
        expect(encodeSource({ ts_path: '/recorded/a.m2ts', library_path: '/library/a.mkv' })).toBe(
            '/recorded/a.m2ts',
        );
    });

    test('引き継いだ録画は保存先の生TSを元にできる', () => {
        // EPGStation 側でエンコードが済んでいなかったもの。ts_path を持たない
        expect(encodeSource({ ts_path: null, library_path: '/library/a.m2ts' })).toBe('/library/a.m2ts');
        expect(encodeSource({ ts_path: null, library_path: '/library/a.ts' })).toBe('/library/a.ts');
    });

    test('エンコード済みは元にしない', () => {
        // 録り直しても画質は戻らないので、再エンコードのボタン自体を出さない
        expect(encodeSource({ ts_path: null, library_path: '/library/a.mkv' })).toBeNull();
        expect(encodeSource({ ts_path: null, library_path: null })).toBeNull();
    });

    test('拡張子は大文字でも見る', () => {
        expect(isRawTs('/library/A.M2TS')).toBe(true);
        expect(isRawTs('/library/a.mkv')).toBe(false);
        expect(isRawTs(null)).toBe(false);
    });
});
