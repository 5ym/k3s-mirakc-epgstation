import { describe, expect, test } from 'bun:test';
import { boundaries, chapterMetadata, detectCmRanges, isCmLength, keepRanges, parseSilences } from './cm';
import { cmRatio, invertRanges, parseTrimRanges, tooMuchCm } from './cm-jls';

describe('parseSilences', () => {
    test('silencedetect のログから無音区間と尺を取る', () => {
        const log = [
            "Input #0, mpegts, from 'a.m2ts':",
            '  Duration: 00:30:00.00, start: 0.000000, bitrate: 15000 kb/s',
            '[silencedetect @ 0x1] silence_start: 299.8',
            '[silencedetect @ 0x1] silence_end: 300.2 | silence_duration: 0.4',
        ].join('\n');
        const { silences, duration } = parseSilences(log);
        expect(duration).toBe(1800);
        expect(silences).toEqual([{ start: 299.8, end: 300.2 }]);
    });

    test('silence_end が来ていない途中の無音は捨てる', () => {
        const { silences } = parseSilences('[silencedetect] silence_start: 10.0');
        expect(silences).toHaveLength(0);
    });
});

describe('isCmLength', () => {
    test('15秒の倍数を許容誤差内で判定する', () => {
        expect(isCmLength(15, 0.6)).toBe(true);
        expect(isCmLength(59.7, 0.6)).toBe(true);
        expect(isCmLength(90, 0.6)).toBe(true);
        expect(isCmLength(22, 0.6)).toBe(false);
        // 本編は15の倍数に乗っても長すぎるので弾く
        expect(isCmLength(600, 0.6)).toBe(false);
    });
});

describe('detectCmRanges', () => {
    const silencesAt = (points: number[]) => points.map((t) => ({ start: t - 0.2, end: t + 0.2 }));

    test('無音で区切られた60秒の塊をCMとして拾う', () => {
        const cm = detectCmRanges(silencesAt([300, 360]), 1800);
        expect(cm).toEqual([{ start: 300, end: 360 }]);
    });

    test('連続するCM尺セグメントは1ブロックにまとめる', () => {
        const cm = detectCmRanges(silencesAt([300, 330, 360, 390]), 1800);
        expect(cm).toEqual([{ start: 300, end: 390 }]);
    });

    test('単発の15秒は本編のコーナーと区別が付かないので拾わない', () => {
        expect(detectCmRanges(silencesAt([300, 315]), 1800)).toEqual([]);
    });

    test('半分以上がCM判定になったら検出失敗とみなして何も返さない', () => {
        // 60秒ごとに無音が入っている = ほぼ全部がCM尺になってしまうケース
        const points = Array.from({ length: 20 }, (_, i) => (i + 1) * 60);
        expect(detectCmRanges(silencesAt(points), 1260)).toEqual([]);
    });

    test('尺が取れないときは何も返さない', () => {
        expect(detectCmRanges(silencesAt([300, 360]), NaN)).toEqual([]);
    });

    test('境界は先頭と末尾を必ず含む', () => {
        expect(boundaries(silencesAt([100]), 200)).toEqual([0, 100, 200]);
    });
});

describe('keepRanges', () => {
    test('CM区間の裏返しになる', () => {
        expect(keepRanges([{ start: 300, end: 360 }], 1800)).toEqual([
            { start: 0, end: 300 },
            { start: 360, end: 1800 },
        ]);
    });

    test('先頭がCMなら本編は1区間だけ', () => {
        expect(keepRanges([{ start: 0, end: 60 }], 600)).toEqual([{ start: 60, end: 600 }]);
    });
});

describe('chapterMetadata', () => {
    test('本編とCMが時刻順のチャプターになる', () => {
        const meta = chapterMetadata([{ start: 300, end: 360 }], 600);
        expect(meta.startsWith(';FFMETADATA1')).toBe(true);
        expect(meta).toContain('START=0');
        expect(meta).toContain('END=300000');
        expect(meta).toContain('title=CM');
        expect(meta).toContain('title=本編');
        // 本編 → CM → 本編 の3チャプター
        expect(meta.match(/\[CHAPTER\]/g)).toHaveLength(3);
    });
});

describe('join_logo_scp の出力', () => {
    test('avs の Trim をフレームから秒に直す', () => {
        const ranges = parseTrimRanges('Trim(0,2996)++Trim(4497,8993)', 30000 / 1001);
        expect(ranges[0].start).toBeCloseTo(0, 3);
        expect(ranges[0].end).toBeCloseTo(99.99, 1);
        expect(ranges[1].start).toBeCloseTo(150.05, 1);
    });

    test('Trim が無ければ空', () => {
        expect(parseTrimRanges('# no trim here', 29.97)).toEqual([]);
    });

    test('番組の半分以上がCMになったら信じない', () => {
        /*
         * 実機で起きたやつ。ロゴを覚えたての回で join_logo_scp が Trim(0,59) だけを
         * 返し、30分アニメが丸ごとCM扱いになっていた
         */
        const whole = invertRanges(parseTrimRanges('Trim(0,59)', 30000 / 1001), 1802);
        expect(cmRatio(whole, 1802)).toBe(100);
        expect(tooMuchCm(whole, 1802)).toBe(true);

        // まともな結果 (本編4ブロック) は通す
        const normal = invertRanges(
            parseTrimRanges(
                'Trim(52,7513) ++ Trim(9313,20520) ++ Trim(22320,46354) ++ Trim(48154,48602)',
                30000 / 1001,
            ),
            1802,
        );
        expect(tooMuchCm(normal, 1802)).toBe(false);
        expect(cmRatio(normal, 1802)).toBeLessThan(30);
    });

    test('残す区間を裏返してCM区間にする', () => {
        expect(
            invertRanges(
                [
                    { start: 0, end: 100 },
                    { start: 160, end: 600 },
                ],
                600,
            ),
        ).toEqual([{ start: 100, end: 160 }]);
    });
});

describe('ロゴの位置を教える口を出すか', () => {
    test('CM検出の覚え書きから決める。別の印は持たない', async () => {
        const { logoUnusable } = await import('../format');
        /*
         * 実機に残っていた文言。印を別に持っていた頃は、後から条件を広げても
         * 既に録ってある分には効かなかった
         */
        expect(logoUnusable('無音 8 箇所 (jls は使えず: logoframe が失敗 (code 1): ...)')).toBe(true);
        expect(logoUnusable('無音 30 箇所 (jls は使えず: 結果の 100% がCM判定なので使いません)')).toBe(true);
        // ロゴで判定できている。ここで出すと、直しようのないものまで拾う
        expect(logoUnusable('join_logo_scp')).toBe(false);
        expect(logoUnusable('無音 8 箇所')).toBe(false);
        expect(logoUnusable(null)).toBe(false);
    });
});
