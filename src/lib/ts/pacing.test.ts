import { describe, expect, test } from 'bun:test';
import { CEILING, FLOOR, JUMP, nextTarget, pacing, SETTLED } from './pacing';

/** 宅内で落ち着いている状態 */
const at = (over: Partial<Parameters<typeof pacing>[0]>) =>
    pacing({ start: 100, end: 100 + FLOOR, at: 100, playing: true, target: FLOOR, ...over });

/**
 * **ここが「かくつき」の分かれ目。** 届いた端で再生すると、1コマ遅れるたびに
 * 止まる。少し貯めてから出し、離れたら速めて詰める。
 */
describe('再生位置の決め方', () => {
    test('範囲の外に居たら、持っている先頭へ移る', () => {
        // -copyts で放送の時刻をそのまま持っているので、0 秒から始まらない
        expect(at({ start: 50_000, end: 50_002, at: 0, playing: false })).toEqual({
            seek: 50_000,
            play: false,
            rate: 1,
        });
    });

    test('貯まるまでは始めない', () => {
        expect(at({ end: 100 + FLOOR / 2, playing: false }).play).toBe(false);
    });

    test('貯まったら始める', () => {
        const after = at({ playing: false });
        expect(after.play).toBe(true);
        expect(after.seek).toBeNull();
    });

    /*
     * **跳ぶのは大きく離れたときだけ。** 跳ぶと音が切れるので、常用すると
     * それ自体が「かくつき」になる
     */
    test('少し離れたら、跳ばずに速めて詰める', () => {
        const late = at({ end: 100 + FLOOR * 2 });
        expect(late.seek).toBeNull();
        expect(late.rate).toBeGreaterThan(1);
    });

    test('大きく離れたら跳ぶ', () => {
        const far = at({ end: 100 + FLOOR + JUMP + 5 });
        expect(far.seek).toBe(100 + FLOOR + JUMP + 5 - FLOOR);
        expect(far.rate).toBe(1);
    });

    test('追いついたら速さを戻す', () => {
        expect(at({}).rate).toBe(1);
    });

    /*
     * **狙いの近くに居着かせる。** 帯を広く採っていた頃は、実機で 0.4 秒を
     * 狙って 0.70 秒に居着いていた (始めた直後は必ず狙いより溜まるので、
     * 放っておくと下りてこない)
     */
    test('狙いの2倍まで溜まったら詰めにかかる', () => {
        expect(at({ end: 100 + FLOOR * 2 }).rate).toBeGreaterThan(1);
    });

    /*
     * **戻す境目と速める境目を離してある。** 同じ値だと、そのあたりで
     * 速める・戻すを往復して、かえって見づらくなる
     */
    test('境目の間では速さをいじらない', () => {
        const between = at({ end: 100 + FLOOR * 1.3 });
        expect(between.rate).toBeNull();
        expect(between.seek).toBeNull();
    });

    /*
     * **貯める量が増えても、跳ぶ境目はそのぶん先へずれる。** ずれないと、
     * 宅外向けに大きく貯めた状態が「離れすぎ」と見なされて跳び続ける
     */
    test('たくさん貯めているときに、それを離れすぎとは見ない', () => {
        const generous = at({ target: 4, end: 100 + 4 });
        expect(generous.seek).toBeNull();
        expect(generous.rate).toBe(1);
    });
});

/**
 * **宅内と宅外で必要な量が桁違いに違う。** どちらから見ているかは分からないので、
 * 実際に止まったかどうかで決める。
 */
describe('貯める量の決め直し', () => {
    test('詰まったら伸ばす', () => {
        expect(nextTarget(FLOOR, true, 0)).toBeGreaterThan(FLOOR);
    });

    test('無事が続いたら縮める', () => {
        expect(nextTarget(2, false, SETTLED)).toBeLessThan(2);
    });

    test('無事でも、すぐには縮めない', () => {
        expect(nextTarget(2, false, SETTLED - 1)).toBe(2);
    });

    /** **伸ばすほうを大きく採る。** 縮めて止まると「直っていない」としか映らない */
    test('伸ばす量のほうが、縮める量より大きい', () => {
        const grown = nextTarget(1, true, 0) - 1;
        const shrunk = 1 - nextTarget(1, false, SETTLED);
        expect(grown).toBeGreaterThan(shrunk);
    });

    test('下限より下げず、上限より上げない', () => {
        expect(nextTarget(FLOOR, false, SETTLED * 10)).toBe(FLOOR);
        expect(nextTarget(CEILING, true, 0)).toBe(CEILING);
    });
});
