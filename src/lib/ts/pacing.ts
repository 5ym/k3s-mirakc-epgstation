/**
 * ライブの再生位置の決め方。**放送は待ってくれないが、目は待てない。**
 *
 * 届いた端でそのまま再生すると、1コマ遅れるたびに映像が止まる。ネットワークも
 * エンコードも一定では届かないので、これは常時起きる。少しだけ貯めてから出し、
 * 離れたら少し速く再生して詰める。跳ぶのは大きく離れたときだけ — 跳ぶと
 * 音が切れるので、常用すると「かくつき」そのものになる。
 *
 * DOM を触らないので、ここだけ単体で確かめられる。
 */

/** 貯めてから出す秒数。**0だと1コマ遅れるたびに止まる** */
export const TARGET = 1.0;
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
export function pacing({ start, end, at, playing }: Buffered): Pacing {
    // 範囲の外に居る。チャンネルを変えた直後もここを通る
    if (at < start || at > end) return { seek: start, play: false, rate: 1 };

    // まだ貯まっていない。始めると、すぐ足りなくなって止まる
    if (!playing) return { seek: null, play: end - at >= TARGET, rate: 1 };

    const lag = end - at;
    // 大きく離れた。**詰めきれないので跳ぶ** — 別のタブから戻ってきたとき
    if (lag > JUMP) return { seek: end - TARGET, play: true, rate: 1 };
    // 少し離れた。速めて詰める。跳ばないので音は切れない
    if (lag > TARGET * 2.5) return { seek: null, play: true, rate: CATCH_UP };
    // 追いついた。戻す。**溜まりを使い切る前に戻す**ので、少し余裕を残す
    if (lag <= TARGET * 1.2) return { seek: null, play: true, rate: 1 };
    // その間。速さは今のまま (ここで戻すと、速める・戻すを往復する)
    return { seek: null, play: true, rate: null };
}
