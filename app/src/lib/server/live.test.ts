import { describe, expect, test } from 'bun:test';
import { av1Args, findProfile, h264Args, PROFILES } from './live';

/** 引数配列から `-key value` の value を取り出す */
function argValue(args: string[], key: string): string | undefined {
    const i = args.indexOf(key);
    return i === -1 ? undefined : args[i + 1];
}

describe('ライブ配信のプロファイル', () => {
    test('h264 と av1 の2種類', () => {
        expect(PROFILES.map((p) => p.id)).toEqual(['h264', 'av1']);
        expect(findProfile('h264')?.contentType).toBe('video/mp2t');
        expect(findProfile('av1')?.contentType).toBe('video/x-matroska');
        expect(findProfile('vp9')).toBeUndefined();
    });

    test('どちらもARIB字幕をビットマップとして取り出す', () => {
        for (const args of [h264Args(), av1Args()]) {
            expect(argValue(args, '-sub_type')).toBe('bitmap');
            expect(argValue(args, '-font')).toBe('Rounded M+ 1m for ARIB');
            // デコーダのオプションなので入力(-i)より前に無いと効かない
            expect(args.indexOf('-sub_type')).toBeLessThan(args.indexOf('-i'));
            // 字幕が無い放送でも落ちないように ? を付ける
            expect(args).toContain('0:s?');
        }
    });

    test('h264 は MPEG-TS + DVB字幕', () => {
        const args = h264Args();
        expect(argValue(args, '-c:v')).toBe('libx264');
        expect(argValue(args, '-c:a')).toBe('aac');
        // dvbsub は MPEG-TS 本来の字幕形式で Jellyfin もそのまま扱える
        expect(argValue(args, '-c:s')).toBe('dvbsub');
        expect(argValue(args, '-f')).toBe('mpegts');
        expect(args.at(-1)).toBe('pipe:1');
        // 8bit。10bitを再生できないクライアントが残っている
        expect(argValue(args, '-vf')).toContain('yuv420p');
        expect(argValue(args, '-vf')).not.toContain('10le');
    });

    test('av1 は Matroska + dvdsub', () => {
        const args = av1Args();
        expect(argValue(args, '-c:v')).toBe('libsvtav1');
        expect(argValue(args, '-c:a')).toBe('libopus');
        // dvdsub は MPEG-TS に入れられないので Matroska で包む
        expect(argValue(args, '-c:s')).toBe('dvdsub');
        expect(args.slice(-3)).toEqual(['-live', '1', 'pipe:1']);
        expect(args).toContain('matroska');
        expect(argValue(args, '-vf')).toContain('yuv420p10le');
    });

    test('ライブは 29.97p で出す (59.94p にすると実時間に間に合わない)', () => {
        for (const args of [h264Args(), av1Args()]) {
            expect(argValue(args, '-vf')).toContain('bwdif=mode=send_frame');
        }
    });
});
