import { describe, expect, test } from 'bun:test';
import { duration, durationMs, recordedDuration } from './format';

const MIN = 60_000;

describe('長さの表示', () => {
    test('1時間未満は分だけ', () => {
        expect(durationMs(25 * MIN)).toBe('25分');
    });

    test('端数が無ければ時間だけ', () => {
        // 「2時間0分」は読みにくい
        expect(durationMs(120 * MIN)).toBe('2時間');
    });

    test('端数があれば時間と分', () => {
        expect(durationMs(95 * MIN)).toBe('1時間35分');
    });

    test('放送日時からも出せる', () => {
        expect(duration(0, 30 * MIN)).toBe('30分');
    });
});

describe('録画の長さ', () => {
    // 番組表の尺は30分
    const scheduled = { start_at: 0, end_at: 30 * MIN };

    test('実際に録れた長さがあればそちらを出す', () => {
        // 途中で止めたので12分しか録れていない
        expect(recordedDuration({ ...scheduled, duration_ms: 12 * MIN })).toBe('12分');
    });

    test('取れていない古い行は番組表の尺で代用する', () => {
        expect(recordedDuration({ ...scheduled, duration_ms: null })).toBe('30分');
    });

    test('0 は取れていないものとして扱う', () => {
        // 1バイトも受信できずに失敗した行が「0分」になると、
        // 長さが取れていないのか本当に0なのか見分けられない
        expect(recordedDuration({ ...scheduled, duration_ms: 0 })).toBe('30分');
    });
});
