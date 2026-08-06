import { describe, expect, test } from 'bun:test';
import { encodeArgs } from './live';

/**
 * **焼き方の指定は、間違えても絵は出る。** 出たうえで見づらいだけなので、
 * 気付くのに時間がかかる。実機で測って分かったものをここで固定する。
 */
describe('ライブの焼き方', () => {
    /*
     * **`-flags low_delay` を入れない。**
     *
     * `-i` より前に書くとエンコーダではなくデコーダに効く。放送の MPEG-2 には
     * B フレームがあるので、この指定を受けたデコーダは表示順ではなく復号順で
     * 絵を出し、1枚進んでは戻るように見える。実測で隣り合うコマの差の比が
     * 2.17 → 1.11 に落ちた (素材のフィールドを直に測ると 1.02)。
     * エンコーダ側の遅れは `-tune zerolatency` が見ている。
     */
    test('デコーダに低遅延を指図しない', () => {
        expect(encodeArgs(true)).not.toContain('low_delay');
    });

    /*
     * **コマごとに切らない。** `frag_every_frame` だと映像だけ・音声だけの塊が
     * 交互に並び (トラックごとにコマの間隔が違うため)、受け側の MSE が
     * それぞれを別の区切りとして扱って映像と音声を別々に並べ直す。
     * 実機では毎秒95個出ていた
     */
    test('0.2秒ごとに区切る', () => {
        const args = encodeArgs(true);
        expect(args.join(' ')).not.toContain('frag_every_frame');
        expect(args[args.indexOf('-frag_duration') + 1]).toBe('200000');
    });

    /*
     * **インタレ解除は録画と同じ判断で行う。** 放送は 1080i なので、解かずに
     * 渡すと動きのある場面が櫛状になる。国内アニメだけコマ数を倍にしない
     */
    test('インタレを解く。国内アニメだけコマ数を倍にしない', () => {
        expect(encodeArgs(true)[encodeArgs(true).indexOf('-vf') + 1]).toBe('bwdif');
        expect(encodeArgs(false)[encodeArgs(false).indexOf('-vf') + 1]).toBe('bwdif=mode=send_frame');
    });

    /** 第2段階で字幕を映像と同じ物差しに並べるのに要る */
    test('元TSの時刻を保つ', () => {
        expect(encodeArgs(true)).toContain('-copyts');
    });
});
