import { describe, expect, test } from 'bun:test';
import { encodeArgs } from './live';

/** 実写・ステレオ・NHK総合1 (T27 に2局乗っている) */
const plain = () => encodeArgs(1024, true, false);

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
        expect(plain()).not.toContain('low_delay');
    });

    /*
     * **コマごとに切らない。** `frag_every_frame` だと映像だけ・音声だけの塊が
     * 交互に並び (トラックごとにコマの間隔が違うため)、受け側の MSE が
     * それぞれを別の区切りとして扱って映像と音声を別々に並べ直す。
     * 実機では毎秒95個出ていた。
     *
     * **細かさの下限は音声のコマが決める。** AAC は 1024 標本 = 約 21ms なので、
     * それより短く切ると音声の入らない塊が出る (実機で 16ms にすると
     * 塊あたりのトラック数が 1.94 → 1.74 に落ちた)
     */
    test('音声のコマより短く区切らない', () => {
        const args = plain();
        expect(args.join(' ')).not.toContain('frag_every_frame');
        const µs = Number(args[args.indexOf('-frag_duration') + 1]);
        expect(µs).toBeGreaterThanOrEqual(25_000);
        expect(µs).toBeLessThanOrEqual(200_000);
    });

    /*
     * **インタレ解除は録画と同じ判断で行う。** 放送は 1080i なので、解かずに
     * 渡すと動きのある場面が櫛状になる。国内アニメだけコマ数を倍にしない
     */
    test('インタレを解く。国内アニメだけコマ数を倍にしない', () => {
        const live = encodeArgs(1024, true, false);
        const anime = encodeArgs(1024, false, false);
        expect(live[live.indexOf('-vf') + 1]).toBe('bwdif');
        expect(anime[anime.indexOf('-vf') + 1]).toBe('bwdif=mode=send_frame');
    });

    /*
     * **局を名指しで選ぶ。** 1本の物理チャンネルに複数の局が乗っているので、
     * `0:v:0` は「最初に見つけた映像」でしかない。実機の T26 には Eテレ1/2/3 と
     * **ワンセグ** (320x180 の H.264) が並んでいて、それを掴む目まである
     */
    test('選んだ局の中から映像と音声を採る', () => {
        const args = encodeArgs(1032, true, false);
        expect(args).toContain('0:p:1032:v:0');
        expect(args).toContain('0:p:1032:a:0');
    });

    /** 局が分からないときは従来どおり。**絵が出ないより、先頭の局のほうがまし** */
    test('局が分からなければ最初に見つけた映像を採る', () => {
        const args = encodeArgs(0, true, false);
        expect(args).toContain('0:v:0');
        expect(args).toContain('0:a:0');
    });

    /*
     * **二カ国語は左右に別の言語。** そのままステレオにすると両方同時に鳴る。
     * 録画は左右を2トラックに分けるが、こちらは器が1つなので主音声 (左) を採る
     */
    test('二カ国語のときは主音声だけを両耳へ', () => {
        const args = encodeArgs(1024, true, true);
        expect(args[args.indexOf('-af') + 1]).toBe('pan=stereo|c0=c0|c1=c0');
    });

    test('普通のステレオでは音をいじらない', () => {
        expect(plain()).not.toContain('-af');
    });

    /*
     * **開いてから絵が出るまでの待ちは、ほぼ解析待ち。** 既定の 5MB は実機の
     * 放送で 2.2 秒ぶんにあたる (毎秒 2.1MB)。放送の PAT/PMT はおよそ 0.1 秒
     * 周期なので、0.7 秒ぶんあれば選局直後のどこから始まっても何周ぶんかは入る
     */
    test('解析待ちを詰める', () => {
        const args = plain();
        expect(args[args.indexOf('-probesize') + 1]).toBe('1500000');
    });

    /** 第2段階で字幕を映像と同じ物差しに並べるのに要る */
    test('元TSの時刻を保つ', () => {
        expect(plain()).toContain('-copyts');
    });
});
