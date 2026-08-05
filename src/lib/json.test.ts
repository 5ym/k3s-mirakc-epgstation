import { describe, expect, test } from 'bun:test';
import { jsonArray } from './json';

/**
 * **読めなければ空。** 入っているのはルールの対象チャンネルや番組のジャンルで、
 * 例外を投げると画面ごと出なくなる。空なら「条件なし」と同じ扱いで済む。
 */
describe('JSON で持っている列を読む', () => {
    test('配列はそのまま', () => {
        expect(jsonArray<number>('[1,2,3]')).toEqual([1, 2, 3]);
        expect(jsonArray<string>('["GR","BS"]')).toEqual(['GR', 'BS']);
    });

    test('入っていなければ空', () => {
        expect(jsonArray(null)).toEqual([]);
        expect(jsonArray(undefined)).toEqual([]);
        expect(jsonArray('')).toEqual([]);
    });

    test('壊れていても空。投げない', () => {
        expect(jsonArray('[1,2')).toEqual([]);
        expect(jsonArray('なにか')).toEqual([]);
    });

    test('配列以外は捨てる', () => {
        // 数や文字が入っていたときに、そのまま `.map` へ渡すと落ちる
        expect(jsonArray('{"a":1}')).toEqual([]);
        expect(jsonArray('7')).toEqual([]);
        expect(jsonArray('null')).toEqual([]);
    });
});
