import { describe, expect, test } from 'bun:test';
import { parseTitle, sanitizeFileName, toHalfWidth } from './title';

describe('parseTitle', () => {
    test('装飾記号を落としてシリーズ名にする', () => {
        expect(parseTitle('【新】テスト番組').series).toBe('テスト番組');
        expect(parseTitle('テスト番組[字][解]').series).toBe('テスト番組');
    });

    test('鍵括弧をサブタイトルとして切り出す', () => {
        const parsed = parseTitle('推しの番組「はじまりの日」');
        expect(parsed.series).toBe('推しの番組');
        expect(parsed.subtitle).toBe('はじまりの日');
    });

    test('話数はシリーズ名から外し、その後ろをサブタイトルにする', () => {
        const parsed = parseTitle('テストアニメ #12 決戦');
        expect(parsed.series).toBe('テストアニメ');
        expect(parsed.episode).toBe(12);
        expect(parsed.subtitle).toBe('決戦');
    });

    test('第N話 表記も拾う', () => {
        expect(parseTitle('ドラマ 第3話').episode).toBe(3);
        expect(parseTitle('ドラマ 第3話').series).toBe('ドラマ');
    });

    test('全角は半角に寄せる', () => {
        expect(toHalfWidth('ＴＯＫＹＯ　ＭＸ')).toBe('TOKYO MX');
    });

    test('空文字でも落ちない', () => {
        expect(parseTitle('').series).toBe('untitled');
    });

    test('話数もサブタイトルも無ければ番組名がそのままシリーズ名', () => {
        expect(parseTitle('ニュース').series).toBe('ニュース');
        expect(parseTitle('ニュース').subtitle).toBe('');
    });
});

describe('sanitizeFileName', () => {
    test('パス区切りとWindowsの禁止文字を落とす', () => {
        expect(sanitizeFileName('a/b:c*d?e"f<g>h|i')).toBe('a b c d e f g h i');
    });

    test('末尾のドットとスペースを落とす', () => {
        expect(sanitizeFileName('番組名... ')).toBe('番組名');
    });

    test('全部消えたら untitled にする', () => {
        expect(sanitizeFileName('///')).toBe('untitled');
    });

    test('長すぎる名前は切り詰める', () => {
        expect(sanitizeFileName('あ'.repeat(200)).length).toBeLessThanOrEqual(60);
    });
});
