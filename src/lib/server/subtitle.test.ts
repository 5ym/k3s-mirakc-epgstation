import { describe, expect, test } from 'bun:test';
import { pgsArgs, rebase } from './subtitle';

/*
 * **字幕がどの時刻から始まるか。**
 *
 * 字幕を絵にする ffmpeg と、焼く ffmpeg は別々に同じ TS を開く。
 * 時刻を数え直す基準が両者で違うと、そのぶんだけ字幕がずれる。
 *
 * 実機 (火アニバル 攻殻機動隊 #05) で起きたのがそれで、
 *
 * - 入れ物の始まり  6115.509 (放送の時刻そのもの)
 * - 最初の字幕      6125.899 → 頭から 10.39 秒後
 *
 * のところ、字幕側だけが**最初の字幕を 0 秒**として数えていた。
 * 出来上がりでは字幕が 10 秒早く出ていた (画面ではCMの上に本編の台詞が乗った)。
 */
describe('放送の時刻から出来上がりの時刻へ', () => {
    const FORMAT_START = 6115.509489;

    test('入れ物の始まりを引く', () => {
        // 最初の字幕は録画開始の 10.39 秒後。そこに出る
        expect(rebase(6125.8993, FORMAT_START)).toBeCloseTo(10.3898, 4);
        expect(rebase(6126.016066, FORMAT_START)).toBeCloseTo(10.5066, 4);
    });

    test('頭より前のものは 0 に詰める', () => {
        // PGS の時刻は負を持てない
        expect(rebase(6115.0, FORMAT_START)).toBe(0);
    });

    test('入れ物の始まりが読めなければ引かない', () => {
        // 字幕が入らないよりはまし。以前と同じ振る舞いに戻るだけ
        expect(rebase(12.5, Number.NaN)).toBe(12.5);
    });
});

describe('字幕を取り出す引数', () => {
    const args = pgsArgs('/rec/a.m2ts', '1920x1080', 'Rounded M+ 1m for ARIB');

    test('時刻を数え直させない', () => {
        // これが無いと ffmpeg は最初の字幕を 0 秒とみなす
        expect(args).toContain('-copyts');
    });

    test('画面の大きさを渡す', () => {
        // 渡さないと libaribcaption は 1440x1080 とみなし、字幕だけ横に伸びる
        expect(args[args.indexOf('-canvas_size') + 1]).toBe('1920x1080');
    });

    test('大きさが分からなければ渡さない', () => {
        expect(pgsArgs('/rec/a.m2ts', undefined, 'x')).not.toContain('-canvas_size');
    });

    test('字幕をフィルタに通して1枚ずつ絵にする', () => {
        expect(args[args.indexOf('-filter_complex') + 1]).toBe('[0:s:0]showinfo[v]');
        expect(args.at(-1)).toBe('pipe:1');
    });
});
