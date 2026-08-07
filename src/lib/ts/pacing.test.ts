import { describe, expect, test } from 'bun:test';
import { JUMP, pacing, TARGET } from './pacing';

/**
 * **ここが「かくつき」の分かれ目。** 届いた端で再生すると、1コマ遅れるたびに
 * 止まる。少し貯めてから出し、離れたら速めて詰める。
 */
describe('再生位置の決め方', () => {
    test('範囲の外に居たら、持っている先頭へ移る', () => {
        // -copyts で放送の時刻をそのまま持っているので、0 秒から始まらない
        expect(pacing({ start: 50_000, end: 50_002, at: 0, playing: false })).toEqual({
            seek: 50_000,
            play: false,
            rate: 1,
        });
    });

    test('貯まるまでは始めない', () => {
        const before = pacing({ start: 100, end: 100 + TARGET / 2, at: 100, playing: false });
        expect(before.play).toBe(false);
    });

    test('貯まったら始める', () => {
        const after = pacing({ start: 100, end: 100 + TARGET, at: 100, playing: false });
        expect(after.play).toBe(true);
        expect(after.seek).toBeNull();
    });

    /*
     * **跳ぶのは大きく離れたときだけ。** 跳ぶと音が切れるので、常用すると
     * それ自体が「かくつき」になる
     */
    test('少し離れたら、跳ばずに速めて詰める', () => {
        const late = pacing({ start: 100, end: 100 + TARGET * 2, at: 100, playing: true });
        expect(late.seek).toBeNull();
        expect(late.rate).toBeGreaterThan(1);
    });

    test('大きく離れたら跳ぶ', () => {
        const far = pacing({ start: 100, end: 100 + JUMP + 5, at: 100, playing: true });
        expect(far.seek).toBe(100 + JUMP + 5 - TARGET);
        expect(far.rate).toBe(1);
    });

    test('追いついたら速さを戻す', () => {
        const caught = pacing({ start: 100, end: 100 + TARGET, at: 100, playing: true });
        expect(caught.rate).toBe(1);
    });

    /*
     * **狙いの近くに居着かせる。** 帯を広く採っていた頃は、実機で 0.4 秒を
     * 狙って 0.70 秒に居着いていた (始めた直後は必ず狙いより溜まるので、
     * 放っておくと下りてこない)。狙いの2倍まで来たら詰めにかかる
     */
    test('狙いの2倍まで溜まったら詰めにかかる', () => {
        const drifted = pacing({ start: 100, end: 100 + TARGET * 2, at: 100, playing: true });
        expect(drifted.rate).toBeGreaterThan(1);
    });

    /*
     * **戻す境目と速める境目を離してある。** 同じ値だと、そのあたりで
     * 速める・戻すを往復して、かえって見づらくなる
     */
    test('境目の間では速さをいじらない', () => {
        const between = pacing({ start: 100, end: 100 + TARGET * 1.3, at: 100, playing: true });
        expect(between.rate).toBeNull();
        expect(between.seek).toBeNull();
    });
});
