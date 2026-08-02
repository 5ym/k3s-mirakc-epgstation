import { describe, expect, test } from 'bun:test';
import { encodeSource } from './source';

describe('エンコードの元', () => {
    test('生TSがあればそれ', () => {
        expect(encodeSource({ ts_path: '/recorded/a.m2ts' })).toBe('/recorded/a.m2ts');
    });

    test('生TSが無ければ録り直せない', () => {
        // エンコード済みを元に録り直しても画質は戻らないので、ボタン自体を出さない
        expect(encodeSource({ ts_path: null })).toBeNull();
    });
});
