import { describe, expect, test } from 'bun:test';
import {
    buildArgs,
    buildConcatArgs,
    buildSegmentArgs,
    concatList,
    failureReason,
    isVideoCodec,
    parseProgressBlock,
    smoothMotionFor,
} from './encoder';

function argValue(args: string[], key: string): string | undefined {
    const i = args.indexOf(key);
    return i === -1 ? undefined : args[i + 1];
}

describe('録画エンコードの引数', () => {
    test('既定は AV1 10bit で、コマ数は増やさない', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null);
        expect(args).toContain('libsvtav1');
        // send_field だとコマ数が倍になり、時間もサイズも約2倍になる
        expect(argValue(args, '-vf')).toBe('bwdif=mode=send_frame,format=yuv420p10le');
        expect(args.at(-1)).toBe('/out.mkv');
    });

    test('なめらかにすると1フィールドごとに1コマ出す', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { smoothMotion: true });
        expect(argValue(args, '-vf')).toBe('bwdif,format=yuv420p10le');
    });
});

describe('コマ数の決め方', () => {
    test('国内アニメだけコマ数を倍にしない', () => {
        // 元が毎秒24コマ前後なので、フィールドごとに起こしても同じ絵が並ぶだけ
        expect(smoothMotionFor('[{"lv1":7,"lv2":0}]')).toBe(false);
        expect(smoothMotionFor('[{"lv1":0,"lv2":1},{"lv1":7,"lv2":0}]')).toBe(false);
    });

    test('海外アニメと特撮は60コマで出す', () => {
        // 同じ大分類7でも、海外のものは毎秒30コマ、特撮は実写
        expect(smoothMotionFor('[{"lv1":7,"lv2":1}]')).toBe(true);
        expect(smoothMotionFor('[{"lv1":7,"lv2":2}]')).toBe(true);
    });

    test('それ以外は60コマで出す', () => {
        expect(smoothMotionFor('[{"lv1":0,"lv2":0}]')).toBe(true);
        expect(smoothMotionFor('[{"lv1":9,"lv2":0}]')).toBe(true);
    });

    test('ジャンルが分からないものは実写として扱う', () => {
        // 引き継いだ録画や番組情報の無い放送。放送の大半は実写のほう
        expect(smoothMotionFor(null)).toBe(true);
        expect(smoothMotionFor('')).toBe(true);
        expect(smoothMotionFor('こわれている')).toBe(true);
    });

    test('入れ物は拡張子ではなく引数で決める', () => {
        // 書いている間は .mkv.encoding という名前なので、拡張子からは決まらない
        const args = buildArgs('/in.m2ts', '/out.mkv.encoding', 1, null);
        expect(argValue(args, '-f')).toBe('matroska');
        expect(args.at(-1)).toBe('/out.mkv.encoding');
    });

    test('h264 を選ぶと x264 の 8bit になる', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'h264');
        expect(args).toContain('libx264');
        expect(args).not.toContain('libsvtav1');
        expect(argValue(args, '-vf')).toBe('bwdif=mode=send_frame,format=yuv420p');
        expect(args).toContain('-preset');
    });

    test('字幕は PGS 1本だけ。入力も1回しか開かない', () => {
        for (const codec of ['av1', 'h264'] as const) {
            const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, codec, { pgsFile: '/tmp/s.sup' });
            /*
             * ASS (外字が「〓」になる) と dvdsub (1枚4色) を作るために同じ入力を
             * 2回開いていた頃の名残を残さない。PGS が放送どおりに出るので、
             * 見た目の違うものを「字幕」として並べる理由が無くなった
             */
            expect(args.filter((a) => a === '/in.m2ts')).toHaveLength(1);
            expect(args).not.toContain('ass');
            expect(args).not.toContain('dvdsub');
            expect(argValue(args, '-c:s:0')).toBe('copy');
            expect(argValue(args, '-disposition:s:0')).toBe('default');
            expect(argValue(args, '-c:s:1')).toBeUndefined();
            expect(argValue(args, '-c:a')).toBe('libopus');
        }
    });

    test('画面の大きさはここでは使わない', () => {
        // 絵にするのは .sup を作る側 (buildPgs)。エンコード側は copy するだけ
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { canvasSize: '1920x1080' });
        expect(args).not.toContain('-canvas_size');
    });

    test('デュアルモノは左右を別トラックに分ける', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 2, null);
        expect(argValue(args, '-filter_complex')).toContain('channelsplit');
        expect(args).toContain('language=jpn');
        expect(args).toContain('language=und');
    });

    test('再試行時は頭を捨てる', () => {
        expect(argValue(buildArgs('/in.m2ts', '/out.mkv', 1, 0.2), '-ss')).toBe('0.2');
    });

    test('CMを切っても字幕は落とさない', () => {
        // CMはエンコードの前にTSの段階で切るので、エンコード側は素直に字幕を通すだけ
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', {
            keep: [{ start: 0, end: 300 }],
            pgsFile: '/tmp/s.sup',
        });
        expect(args).not.toContain('-sn');
        expect(argValue(args, '-c:s:0')).toBe('copy');
    });

    test('チャプターだけならそれが2つ目の入力になる', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { chaptersFile: '/tmp/c.txt' });
        expect(args).toContain('/tmp/c.txt');
        expect(argValue(args, '-map_chapters')).toBe('1');
    });

    test('PGS は copy でそのまま入れる', () => {
        /*
         * 放送どおりの色数 (1枚256色) が入るのはこれだけ。ffmpeg は PGS を
         * 作れないので denpa が .sup を書いて渡す (src/lib/pgs.ts)
         */
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { pgsFile: '/tmp/s.sup' });
        expect(args).toContain('/tmp/s.sup');
        expect(args).toContain('1:s:0?');
        expect(argValue(args, '-c:s:0')).toBe('copy');
    });

    test('PGS とチャプターが両方あっても番号がずれない', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', {
            pgsFile: '/tmp/s.sup',
            chaptersFile: '/tmp/c.txt',
        });
        expect(args).toContain('1:s:0?');
        // 入力は 本編 / sup / チャプター の順
        expect(argValue(args, '-map_chapters')).toBe('2');
    });

    test('PGS が無ければ字幕トラックは入らない', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null);
        expect(argValue(args, '-c:s:0')).toBeUndefined();
        expect(args.filter((a) => a.startsWith('-disposition:s'))).toHaveLength(0);
    });
});

describe('isVideoCodec', () => {
    test('知っているコーデックだけ通す', () => {
        expect(isVideoCodec('av1')).toBe(true);
        expect(isVideoCodec('h264')).toBe(true);
        expect(isVideoCodec('hevc')).toBe(false);
        expect(isVideoCodec(null)).toBe(false);
    });
});

describe('parseProgressBlock', () => {
    test('経過時間から進捗を出す', () => {
        const p = parseProgressBlock(
            {
                progress: 'continue',
                out_time_us: '30000000',
                total_size: '1048576',
                bitrate: '2000.0',
                speed: '8.0x',
                drop_frames: '0',
            },
            60,
            0,
        );
        expect(p.percent).toBeCloseTo(0.5, 3);
    });

    test('out_time_us が N/A の間は直前の値を保つ', () => {
        const p = parseProgressBlock({ progress: 'continue', out_time_us: 'N/A' }, 60, 0.42);
        expect(p.percent).toBe(0.42);
    });

    test('progress=end で必ず100%にする', () => {
        expect(parseProgressBlock({ progress: 'end', out_time_us: 'N/A' }, NaN, 0.9).percent).toBe(1);
    });
});

describe('failureReason', () => {
    test('警告に埋もれずエラー行を拾う', () => {
        const stderr = [
            '[in#0/mpegts] Codec AVOption font has not been used for any stream.',
            'Stream mapping: Stream #0:3 -> #0:0 (mpeg2video -> av1)',
            '[libsvtav1 @ 0x1] Error initializing the encoder',
            'Conversion failed!',
        ].join('\n');
        const reason = failureReason(stderr);
        expect(reason).toContain('Error initializing the encoder');
        expect(reason).toContain('Conversion failed!');
        expect(reason).not.toContain('has not been used for any stream');
    });

    test('エラー行が無ければ末尾をそのまま出す', () => {
        expect(failureReason('a\nb\nc')).toBe('a\nb\nc');
    });
});

describe('CMを切ったTSを作る', () => {
    test('区間ごとに -c copy で切り出す', () => {
        const args = buildSegmentArgs('/in.m2ts', '/in.m2ts.part0.ts', { start: 12.5, end: 300 });
        // 再エンコードしないので速く、字幕もデータも落ちない
        expect(args).toContain('-c');
        expect(args).toContain('copy');
        expect(argValue(args, '-ss')).toBe('12.5');
        expect(argValue(args, '-to')).toBe('300');
        expect(argValue(args, '-f')).toBe('mpegts');
    });

    test('繋ぎ直しは concat デマクサで、時刻を振り直す', () => {
        const args = buildConcatArgs('/tmp/list.txt', '/out.ts');
        expect(argValue(args, '-f')).toBe('concat');
        expect(args).toContain('-safe');
        // 切れ目で時刻が飛ぶので振り直す
        expect(argValue(args, '-fflags')).toBe('+genpts');
    });

    test('一覧のパスは ' + "'" + ' をエスケープする', () => {
        expect(concatList(['/tmp/a.ts', "/tmp/b's.ts"])).toBe("file '/tmp/a.ts'\nfile '/tmp/b'\\''s.ts'");
    });
});
