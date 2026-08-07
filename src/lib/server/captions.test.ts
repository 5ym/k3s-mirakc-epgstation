import { describe, expect, test } from 'bun:test';
import { CHANNEL } from '$lib/live';
import { CANVAS, captionArgs, frame, PngSplitter, readInfo } from './captions';

/** PNG 1枚ぶんの形だけ真似る (中身は問わない。切れ目を見つけられるかだけ見る) */
const png = (fill: number, size = 20) => {
    const out = new Uint8Array(size).fill(fill);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    return out;
};

describe('字幕の取り出し方', () => {
    /*
     * **`-copyts` が要る。** 付けないと ffmpeg は字幕1枚目を 0 秒として数え直す
     * (フィルタに入れるのが字幕1本だけで、基準になる映像がこちら側に無いため)。
     * 映像側も同じにしてあるので、受け側は届いた時刻と再生位置を直に比べられる
     */
    test('元TSの時刻をそのまま持つ', () => {
        expect(captionArgs(1024)).toContain('-copyts');
    });

    /*
     * **`-canvas_size` が要る。** 無いと libaribcaption は 1440x1080 (PROFILE_A)
     * とみなすので、1920x1080 の放送では字幕だけ横に伸びる
     */
    test('画面の大きさを渡す', () => {
        const args = captionArgs(1024);
        expect(args[args.indexOf('-canvas_size') + 1]).toBe(`${CANVAS.width}x${CANVAS.height}`);
    });

    /*
     * **PNG まで ffmpeg に組ませる。** 実機で同じ TS 30秒ぶんを通した実測:
     * 生の RGBA 1.94秒 (406MB) / PNG 1.05秒 (1.76MB) / 256色 PNG 4.30秒 (0.94MB)。
     * 生のほうが遅いのは書く量が桁違いだから。denpa 側の切り抜き・色数落とし・
     * PNG 組み立ては、まるごと要らない
     */
    test('絵は PNG で受け取る', () => {
        const args = captionArgs(1024);
        expect(args).toContain('image2pipe');
        expect(args[args.indexOf('-c:v') + 1]).toBe('png');
        expect(args).not.toContain('rawvideo');
    });

    /** 局を名指しする。1本の物理チャンネルに複数の局が乗っている (映像と同じ) */
    test('選んだ局の字幕を採る', () => {
        expect(captionArgs(1032).join(' ')).toContain('[0:p:1032:s:0]showinfo');
    });

    test('局が分からなければ最初に見つけた字幕', () => {
        expect(captionArgs(0).join(' ')).toContain('[0:s:0]showinfo');
    });

    /** 出てきた枚をそのまま出す。詰め直させると時刻がずれる */
    test('コマ数を揃え直させない', () => {
        const args = captionArgs(1024);
        expect(args[args.indexOf('-fps_mode') + 1]).toBe('passthrough');
    });
});

/**
 * **空かどうかは showinfo に喋らせる。** `mean:` の最後がアルファの平均で、
 * 0 なら1画素も描かれていない。PNG を解いて確かめる必要が無い。
 */
describe('readInfo', () => {
    const line =
        '[Parsed_showinfo_0 @ 0x1] n:0 pts:1482504240 pts_time:16472.3 duration:1 fmt:rgba ' +
        'sar:0/1 s:1920x1080 i:P iskey:1 type:I checksum:AABBCCDD ' +
        'plane_checksum:[AABBCCDD] mean:[0 0 0 12] stdev:[0.0 0.0 0.0 3.4]';

    test('時刻を読む', () => {
        expect(readInfo(line)?.at).toBe(16472.3);
    });

    test('アルファの平均が 0 なら空', () => {
        expect(readInfo(line)?.blank).toBe(false);
        expect(readInfo(line.replace('mean:[0 0 0 12]', 'mean:[0 0 0 0]'))?.blank).toBe(true);
    });

    test('字幕の行でなければ何も返さない', () => {
        expect(readInfo('[mpeg2video @ 0x1] Invalid frame dimensions 0x0.')).toBeNull();
        expect(readInfo('')).toBeNull();
    });
});

/**
 * PNG は署名で切る。**次の署名が来るまで1枚は完成しない**ので、
 * 最後の1枚は流れが終わってから取り出す。
 */
describe('PngSplitter', () => {
    test('署名で切って1枚ずつ出す', () => {
        const splitter = new PngSplitter();
        const a = png(0x11);
        const b = png(0x22);
        const joined = new Uint8Array(a.length + b.length);
        joined.set(a);
        joined.set(b, a.length);

        // 2枚ぶん食わせても、完成するのは1枚目だけ (2枚目の終わりが分からない)
        const out = splitter.feed(joined);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(a);
        expect(splitter.flush()).toEqual(b);
    });

    /** パイプなので、箱の切れ目で届くとは限らない */
    test('途中で切れて届いても組み直す', () => {
        const splitter = new PngSplitter();
        const a = png(0x11, 30);
        const b = png(0x22, 30);
        expect(splitter.feed(a.subarray(0, 5))).toHaveLength(0);
        expect(splitter.feed(a.subarray(5))).toHaveLength(0);
        const out = splitter.feed(b);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(a);
    });

    test('署名の前に来たごみは捨てる', () => {
        const splitter = new PngSplitter();
        const a = png(0x11);
        const junk = new Uint8Array([1, 2, 3]);
        const joined = new Uint8Array(junk.length + a.length);
        joined.set(junk);
        joined.set(a, junk.length);
        expect(splitter.feed(joined)).toHaveLength(0);
        expect(splitter.flush()).toEqual(a);
    });
});

/**
 * 送る形。頭に置き場所を付ける (stream.md §5.3)。いまは画面まるごとを送るので
 * x,y は 0 だが、**あとで切り抜くようにしても受け側を変えずに済む**。
 */
describe('frame', () => {
    test('絵は種別 0x20 で、頭に置き場所が付く', () => {
        const data = png(0x11);
        const out = frame({ at: 100, data });
        expect(out.kind).toBe(CHANNEL.subtitle);
        const view = new DataView(out.data.buffer, out.data.byteOffset);
        expect([view.getUint16(0), view.getUint16(2), view.getUint16(4), view.getUint16(6)]).toEqual([
            0,
            0,
            CANVAS.width,
            CANVAS.height,
        ]);
        expect(out.data.subarray(8)).toEqual(data);
    });

    test('消すのは種別 0x21 で中身なし', () => {
        const out = frame({ at: 100, data: null });
        expect(out.kind).toBe(CHANNEL.subtitleClear);
        expect(out.data).toHaveLength(0);
    });

    /** 時刻は 90kHz。映像と同じ物差しに乗せるためのもの */
    test('時刻は 90kHz で載せる', () => {
        expect(frame({ at: 16472.3, data: null }).pts).toBe(1482507000n);
    });

    /** 負の時刻は持てない。放送の頭より前を指すことがある */
    test('負の時刻は 0 に詰める', () => {
        expect(frame({ at: -5, data: null }).pts).toBe(0n);
    });
});
