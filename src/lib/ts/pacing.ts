/**
 * ライブの再生位置の決め方。**放送は待ってくれないが、目は待てる。**
 *
 * 届いた端でそのまま再生すると、1コマ遅れるたびに映像が止まる。ネットワークも
 * エンコードも一定では届かないので、これは常時起きる。少しだけ貯めてから出し、
 * 離れたら少し速く再生して詰める。跳ぶのは大きく離れたときだけ — 跳ぶと
 * 音が切れるので、常用すると「かくつき」そのものになる。
 *
 * **どれだけ貯めるかは動かす。** 宅内なら 0.4 秒で足りるが、宅外から見ると
 * 届き方が荒れて止まる。止まったら伸ばし、しばらく無事なら縮める
 * (`nextTarget`)。初めに大きく取ると、開いてから絵が出るまでが遅くなる。
 *
 * DOM を触らないので、ここだけ単体で確かめられる。
 */

/** 貯める量の下限。**開いた直後はここから始める** — 小さいほど早く絵が出る */
export const FLOOR = 0.4;
/** 貯める量の上限。これ以上は、遅れが目に見えて増えるだけ */
export const CEILING = 6;
/** 止まったときに増やす量 */
const GROW = 0.6;
/** 無事だったときに減らす量。**増やすより控えめに** — 減らして止まると元も子もない */
const SHRINK = 0.15;
/**
 * これだけ無事なら縮めにかかる (秒)。
 *
 * **戻りが遅すぎると「直っていない」に見える。** 1回伸びると 0.4 → 1.0 で、
 * 縮むのは 0.15 ずつ。45秒にしていた頃は元に戻るのに3分かかっていた。
 */
export const SETTLED = 30;

/** これ以上離れたら跳ぶ。別のタブへ行って戻ってきたとき */
export const JUMP = 8;
/** 詰めるときの速さ。上げすぎると音程が分かるほど狂う */
const CATCH_UP = 1.05;

export interface Buffered {
    /** 持っている中でいちばん古い時刻 */
    start: number;
    /** いちばん新しい時刻 = 放送の今 */
    end: number;
    /** いま再生している時刻 */
    at: number;
    /** もう再生を始めているか */
    playing: boolean;
    /** どれだけ貯めてから出すか */
    target: number;
}

export interface Pacing {
    /** ここへ移る。移らないなら null */
    seek: number | null;
    /** ここで再生を始める */
    play: boolean;
    /** 再生の速さ。**null は今のまま** (毎回入れ直すと往復する) */
    rate: number | null;
}

/**
 * 次にどうするかを決める。
 *
 * **頭出しは自分で合わせる。** `-copyts` で放送の時刻をそのまま持っているので、
 * 持っている範囲は 0 秒から始まらない (数万秒のこともある)。何もしないと
 * 再生位置が範囲の外に居るままで、1コマも出ない。
 */
export function pacing({ start, end, at, playing, target }: Buffered): Pacing {
    // 範囲の外に居る。チャンネルを変えた直後もここを通る
    if (at < start || at > end) return { seek: start, play: false, rate: 1 };

    // まだ貯まっていない。始めると、すぐ足りなくなって止まる
    if (!playing) return { seek: null, play: end - at >= target, rate: 1 };

    const lag = end - at;
    // 大きく離れた。**詰めきれないので跳ぶ** — 別のタブから戻ってきたとき
    if (lag > target + JUMP) return { seek: end - target, play: true, rate: 1 };
    /*
     * 少し離れた。速めて詰める。跳ばないので音は切れない。
     *
     * **帯を狭く採る。** 2.5倍まで放っておいた頃は、実機で 0.4 秒を狙って
     * 0.70 秒に居着いていた — 始めた直後は必ず狙いより溜まる (再生を頼んでから
     * 実際に絵が出るまでの間にも届く) ので、放っておくとそこから下りてこない。
     */
    if (lag > target * 1.5) return { seek: null, play: true, rate: CATCH_UP };
    // 追いついた。戻す。**溜まりを使い切る前に戻す**ので、少し余裕を残す
    if (lag <= target * 1.1) return { seek: null, play: true, rate: 1 };
    // その間。速さは今のまま (ここで戻すと、速める・戻すを往復する)
    return { seek: null, play: true, rate: null };
}

/**
 * 貯める量を決め直す。**止まったら伸ばし、無事が続いたら縮める。**
 *
 * 宅内と宅外で必要な量が桁違いに違うのに、どちらから見ているかは分からない。
 * 決め打ちにすると、宅内に合わせれば宅外で止まり、宅外に合わせれば宅内が
 * 無駄に遅れる。**実際に止まったかどうかで決める**のがいちばん確か。
 *
 * 伸ばすほうを大きく、縮めるほうを小さくしてある。縮めて止まると、
 * 見ている人には「直っていない」としか映らない。
 *
 * @param target いまの量
 * @param stalled 前回からこちら、詰まったか
 * @param settledFor 最後に詰まってから経った秒数
 */
export function nextTarget(target: number, stalled: boolean, settledFor: number): number {
    if (stalled) return Math.min(CEILING, target + GROW);
    if (settledFor >= SETTLED) return Math.max(FLOOR, target - SHRINK);
    return target;
}
