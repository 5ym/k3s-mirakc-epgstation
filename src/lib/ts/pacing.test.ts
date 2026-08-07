import { describe, expect, test } from 'bun:test';
import { CEILING, FLOOR, JUMP, nextTarget, pacing, SETTLED } from './pacing';

/** 宅内で落ち着いている状態 */
const at = (over: Partial<Parameters<typeof pacing>[0]>) =>
    pacing({
        start: 100,
        end: 100 + FLOOR,
        at: 100,
        playing: true,
        target: FLOOR,
        chasing: false,
        speed: 1,
        ...over,
    });

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
            caught: false,
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
 * 追っかけ再生。**わざと遅れて見ている状態。**
 *
 * ライブと追っかけでは見ているものが違う。ライブは「放送の今」を追うので
 * 大きく離れたら跳ぶのが正しいが、追っかけで跳ぶと**見ようとしていた場面が
 * 飛ぶ**。分けていなかった頃は、止めて再開すると勝手に放送の今へ跳んでいた —
 * 「止めた所から見られる」と謳っておきながら、8秒より長く止めると戻れなかった。
 */
describe('追っかけ再生', () => {
    /** 5分遅れて見ている状態 */
    const chase = (over: Partial<Parameters<typeof pacing>[0]> = {}) =>
        at({ end: 100 + 300, chasing: true, speed: 1.5, ...over });

    test('どれだけ離れていても跳ばない', () => {
        expect(chase().seek).toBeNull();
    });

    /** ライブなら跳んでいた距離で、跳ばないことを確かめる */
    test('ライブなら跳ぶ距離でも、追っかけなら跳ばない', () => {
        const far = { end: 100 + FLOOR + JUMP + 5 };
        expect(at({ ...far, chasing: false }).seek).not.toBeNull();
        expect(at({ ...far, chasing: true, speed: 1 }).seek).toBeNull();
    });

    test('選ばれた速さで進む', () => {
        expect(chase({ speed: 2 }).rate).toBe(2);
        expect(chase({ speed: 1 }).rate).toBe(1);
    });

    /*
     * **追いついたら自分でライブに戻る。** 戻さずに選ばれた速さのまま進むと
     * 放送を追い越し、溜まりを使い切って止まる
     */
    test('追いついたら、速さを戻してライブへ返す', () => {
        const caught = chase({ end: 100 + FLOOR });
        expect(caught.caught).toBe(true);
        expect(caught.rate).toBe(1);
    });

    test('追いつくまでは返さない', () => {
        expect(chase().caught).toBe(false);
    });

    /** 貯める量が増えていれば、追いついたと見なす境目もそのぶん先へ */
    test('たくさん貯めているときは、その手前で追いついたと見る', () => {
        expect(chase({ target: 4, end: 100 + 4 }).caught).toBe(true);
        expect(chase({ target: 4, end: 100 + 20 }).caught).toBe(false);
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

/**
 * **下限は起動時間そのもの。**
 *
 * 再生を始める条件は「貯まった尺 ≧ 貯める量」で、電波は実時間で届くのだから、
 * 0.4 秒貯めるには 0.4 秒かかる。開いてから絵が出るまでの内訳のうち、
 * **こちらの都合で動かせるのはここだけ** (電波のロックも ffmpeg の立ち上がりも
 * 動かせない)。
 */
describe('貯める量の下限', () => {
    /** サーバは 0.05 秒ずつ塊を出す (`server/live.ts` の -frag_duration) */
    const FRAGMENT = 0.05;

    test('塊いくつかぶんに収める', () => {
        expect(FLOOR).toBeLessThanOrEqual(0.25);
        // 1つ2つでは、届き方が少し揺れただけで足りなくなる
        expect(FLOOR).toBeGreaterThanOrEqual(FRAGMENT * 3);
    });

    /*
     * **小さすぎても壊れない。** 足りずに止まったら増える。荒れる経路
     * (宅外) では自分で伸びていくので、下限は宅内に合わせてよい
     */
    test('足りなければ、そこから伸びる', () => {
        let target = FLOOR;
        for (let i = 0; i < 3; i++) target = nextTarget(target, true, 0);
        expect(target).toBeGreaterThan(1);
        expect(target).toBeLessThanOrEqual(CEILING);
    });

    /** 伸びたぶんは、無事が続けば下限まで戻る */
    test('無事が続けば下限まで戻る', () => {
        let target = nextTarget(FLOOR, true, 0);
        for (let i = 0; i < 50; i++) target = nextTarget(target, false, SETTLED);
        expect(target).toBe(FLOOR);
    });
});
