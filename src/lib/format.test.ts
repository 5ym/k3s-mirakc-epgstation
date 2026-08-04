import { describe, expect, test } from 'bun:test';
import { duration, durationMs, eta, percent, recordedDuration } from './format';

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

/*
 * エンコードの進み具合。**細かく出す。**
 *
 * 整数の % と分どまりの残り時間では、1時間かかるエンコードで数字が
 * 30秒以上動かない。止まったのか進んでいるのか画面から判らなかった
 */
describe('進み具合', () => {
    test('小数第1位まで出す', () => {
        expect(percent(0)).toBe('0.0%');
        expect(percent(0.1234)).toBe('12.3%');
        expect(percent(1)).toBe('100.0%');
    });

    test('範囲の外は詰める', () => {
        // 見積もりの総コマ数を超えると 1 を跨ぐことがある
        expect(percent(1.4)).toBe('100.0%');
        expect(percent(-0.2)).toBe('0.0%');
    });
});

describe('残り時間の見込み', () => {
    test('1分未満は秒だけ', () => {
        expect(eta(45_000)).toBe('あと45秒');
        expect(eta(1_000)).toBe('あと1秒');
    });

    test('1時間未満は分と秒', () => {
        expect(eta(12 * MIN + 34_000)).toBe('あと12分34秒');
        // 秒が1桁でも桁を揃える (数字の位置が動くと読みにくい)
        expect(eta(2 * MIN + 5_000)).toBe('あと2分05秒');
    });

    test('1時間以上は時間・分・秒', () => {
        expect(eta(3600_000 + 2 * MIN + 3_000)).toBe('あと1時間02分03秒');
    });

    test('見込みが立たないうちは何も出さない', () => {
        expect(eta(null)).toBe('');
        expect(eta(0)).toBe('');
        expect(eta(Number.NaN)).toBe('');
    });
});
