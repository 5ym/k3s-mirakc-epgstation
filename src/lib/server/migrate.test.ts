import { describe, expect, test } from 'bun:test';
import { parseGenres } from './migrate';

/**
 * EPGStation のジャンル指定の読み取り。
 *
 * ここを取りこぼすと、引き継いだルールのジャンル欄に名前の引けない値が並ぶ。
 * denpa 側は文字列で `"7"`(大分類だけ)と `"7-0"`(中分類まで)を持つ。
 */
describe('ジャンルの引き継ぎ', () => {
    test('中分類まであれば大分類と繋ぐ', () => {
        expect(parseGenres('[{"genre":7,"subGenre":0}]')).toEqual(['7-0']);
    });

    test('大分類だけなら大分類だけ', () => {
        // EPGStation で「アニメ全部」を選んだとき subGenre は入ってこない
        expect(parseGenres('[{"genre":7}]')).toEqual(['7']);
    });

    test('数値の配列でも読める', () => {
        expect(parseGenres('[7,6]')).toEqual(['7', '6']);
    });

    test('引ける形にならないものは落とす', () => {
        // 残すと画面のジャンル欄に名前の引けない値が並ぶ
        expect(parseGenres('[null,{"subGenre":1},{"genre":"7"},7]')).toEqual(['7']);
    });

    test('壊れていても空で返す', () => {
        expect(parseGenres('{壊れている')).toEqual([]);
        expect(parseGenres(null)).toEqual([]);
        expect(parseGenres('')).toEqual([]);
        expect(parseGenres('"文字列"')).toEqual([]);
    });
});
