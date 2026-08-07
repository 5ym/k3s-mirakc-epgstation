import { describe, expect, test } from 'bun:test';
import { type AudioSide, audioTracks } from '$lib/arib';
import { encodeArgs } from './live';

/** 1本目の音声をそのまま。番組表が何も言っていないときの既定 */
const stereo = audioTracks([])[0];
/** デュアルモノの中から選ぶ。0=主音声 1=副音声 2=主+副 */
const dual = (side: AudioSide) => {
    const tracks = audioTracks([{ componentType: 2, langs: ['jpn', 'eng'] }]);
    const found = tracks.find((track) => track.side === side);
    if (found === undefined) throw new Error(`デュアルモノに ${side} が無い`);
    return found;
};

/** 実写・ステレオ・NHK総合1 (T27 に2局乗っている) */
const plain = () => encodeArgs(1024, true, stereo);

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
     * **入口の解析は小さくてよい。渡す前に1局へ絞るから。**
     *
     * ffmpeg は名指しした局を `-probesize` のぶん読む間に見つけられなければ、
     * **そのまま終了する**。実機の tvk (T15。tvk1/2/3 + ワンセグ + データで、
     * 局ごとに14本以上のストリーム) では 400KB でも足りず、
     * `Failed to set value '0:p:24632:v:0' for option 'map'` で降りていた。
     *
     * わざと probesize を下げて T15 で測ったもの (3回ずつ):
     *
     *     20KB   丸ごと 0/3 通る   1局に絞る 3/3
     *     50KB   丸ごと 0/3 通る   1局に絞る 3/3
     *    120KB   丸ごと 1/3 通る   1局に絞る 3/3
     *
     * 絞れば 20KB でも通る。5倍の余裕を見て 100KB。
     *
     * **上げる方向には床がある。** 実測した ffmpeg の立ち上がりは
     * 1.5MB → 1429ms、800KB → 972ms、400KB → 約 700ms、200KB → 754ms。
     * 750ms 前後で止まるのは、放送の MPEG-2 が GOP の頭を待つため
     */
    test('入口の解析は 100KB まで', () => {
        const args = plain();
        expect(args[args.indexOf('-probesize') + 1]).toBe('100000');
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
        const live = encodeArgs(1024, true, stereo);
        const anime = encodeArgs(1024, false, stereo);
        expect(live[live.indexOf('-vf') + 1]).toBe('bwdif');
        expect(anime[anime.indexOf('-vf') + 1]).toBe('bwdif=mode=send_frame');
    });

    /*
     * **局を名指しで選ぶ。** 1本の物理チャンネルに複数の局が乗っているので、
     * `0:v:0` は「最初に見つけた映像」でしかない。実機の T26 には Eテレ1/2/3 と
     * **ワンセグ** (320x180 の H.264) が並んでいて、それを掴む目まである
     */
    test('選んだ局の中から映像と音声を採る', () => {
        const args = encodeArgs(1032, true, stereo);
        expect(args).toContain('0:p:1032:v:0');
        expect(args).toContain('0:p:1032:a:0');
    });

    /** 局が分からないときは従来どおり。**絵が出ないより、先頭の局のほうがまし** */
    test('局が分からなければ最初に見つけた映像を採る', () => {
        const args = encodeArgs(0, true, stereo);
        expect(args).toContain('0:v:0');
        expect(args).toContain('0:a:0');
    });

    /*
     * **二カ国語は左右に別の言語。** そのままステレオにすると両方同時に鳴る。
     * 録画は左右を2トラックに分けるが、こちらは器が1つなので選ばれた側を両耳へ。
     *
     * 右 (`c1`) を左右に配るのが副音声。**左右を取り違えると、選んだのと逆の
     * 言語が鳴る** — 絵は出るので、気付くのは音を聞いたときだけ
     */
    test('二カ国語は選ばれた側だけを両耳へ', () => {
        const main = encodeArgs(1024, true, dual('main'));
        const sub = encodeArgs(1024, true, dual('sub'));
        expect(main[main.indexOf('-af') + 1]).toBe('pan=stereo|c0=c0|c1=c0');
        expect(sub[sub.indexOf('-af') + 1]).toBe('pan=stereo|c0=c1|c1=c1');
    });

    /** 「主+副」はテレビと同じで、左右から別の言語が同時に鳴る状態 */
    test('主+副はそのまま出す', () => {
        expect(encodeArgs(1024, true, dual('both'))).not.toContain('-af');
    });

    test('普通のステレオでは音をいじらない', () => {
        expect(plain()).not.toContain('-af');
    });

    /*
     * **音声が2本以上入っている放送では、0 が選ばれるとは限らない。**
     * 解説放送などは音声そのものが別に乗っているので、何本目かを名指しする
     */
    test('2本目の音声を選べる', () => {
        const tracks = audioTracks([
            { componentType: 3, langs: ['jpn'] },
            { componentType: 3, langs: ['eng'] },
        ]);
        const args = encodeArgs(1032, true, tracks[1]);
        expect(args).toContain('0:p:1032:a:1');
        expect(args).not.toContain('0:p:1032:a:0');
    });

    /** 字幕を映像と同じ物差しに並べるのに要る */
    test('元TSの時刻を保つ', () => {
        expect(plain()).toContain('-copyts');
    });

    /*
     * **字幕と時刻を突き合わせないので、コマごとに喋らせるものが無い。**
     *
     * 絶対の時刻で合わせる道は2回外している (`live.ts` の説明)。いまは受け側が
     * 届いた時点の再生位置に置くので、こちらから添えるものは何も無い。
     * `showinfo` を挟んでいた頃は**毎秒60行**が標準エラーに流れていた
     */
    test('コマごとに showinfo を吐かせない', () => {
        expect(plain()[plain().indexOf('-vf') + 1]).not.toContain('showinfo');
    });

    /*
     * **失敗だけ残す。** `showinfo` を外したので絞れる。字幕側は絞れない
     * (あちらは `showinfo` が info で喋る。`captions.ts`)
     */
    test('記録は失敗だけに絞る', () => {
        const args = plain();
        expect(args[args.indexOf('-loglevel') + 1]).toBe('error');
    });
});
