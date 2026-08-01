import { describe, expect, test } from 'bun:test';
import { buildArgs, failureReason, isVideoCodec, parseProgressBlock } from './encoder';

function argValue(args: string[], key: string): string | undefined {
    const i = args.indexOf(key);
    return i === -1 ? undefined : args[i + 1];
}

describe('録画エンコードの引数', () => {
    test('既定は AV1 10bit', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null);
        expect(args).toContain('libsvtav1');
        expect(argValue(args, '-vf')).toBe('bwdif,format=yuv420p10le');
        expect(args.at(-1)).toBe('/out.mkv');
    });

    test('h264 を選ぶと x264 の 8bit になる', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'h264');
        expect(args).toContain('libx264');
        expect(args).not.toContain('libsvtav1');
        expect(argValue(args, '-vf')).toBe('bwdif,format=yuv420p');
        expect(args).toContain('-preset');
    });

    test('字幕と音声はコーデックによらず同じ', () => {
        for (const codec of ['av1', 'h264'] as const) {
            const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, codec);
            expect(argValue(args, '-c:s')).toBe('dvdsub');
            expect(argValue(args, '-c:a')).toBe('libopus');
        }
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

    test('CM実カット時は select を挟み、字幕は落とす', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', {
            keep: [{ start: 0, end: 300 }],
        });
        expect(argValue(args, '-filter_complex')).toContain("select='between(t,0.000,300.000)'");
        expect(args).toContain('-sn');
        expect(args).not.toContain('dvdsub');
    });

    test('チャプターを渡すと2つ目の入力として読み込む', () => {
        const args = buildArgs('/in.m2ts', '/out.mkv', 1, null, 'av1', { chaptersFile: '/tmp/c.txt' });
        expect(args).toContain('-map_chapters');
        expect(args).toContain('/tmp/c.txt');
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
