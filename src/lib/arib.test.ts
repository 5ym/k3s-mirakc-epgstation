import { describe, expect, test } from 'bun:test';
import { audioLabel, genreLabel, genreName, videoLabel } from './arib';

/**
 * ルールの条件に出す名前。
 *
 * 大分類だけの条件 (「アニメ全部」) は - を含まないので、split の2つ目が
 * undefined になる。`Number.isNaN(undefined)` は false なので素通りしてしまい、
 * 「アニメ／特撮 > undefined」と出ていた。
 */
describe('genreName', () => {
    test('大分類だけの条件は大分類だけ出す', () => {
        expect(genreName('7')).toBe('アニメ／特撮');
        // 引き継いだルールは数値で入っている
        expect(genreName(7)).toBe('アニメ／特撮');
        expect(genreName(0)).toBe('ニュース／報道');
    });

    test('中分類まであれば繋ぐ', () => {
        expect(genreName('7-0')).toBe('アニメ／特撮 > 国内アニメ');
    });

    test('引けない値はそのまま出す', () => {
        // 12・13 は放送に出てこない予備。表に無くても値だけは見せる
        expect(genreName(12)).toBe('12');
        expect(genreName('7-99')).toBe('アニメ／特撮 > 99');
        expect(genreName('7-x')).toBe('アニメ／特撮');
    });
});

describe('genreLabel', () => {
    test('大分類と中分類をつなげる', () => {
        expect(genreLabel({ lv1: 7, lv2: 0 })).toBe('アニメ／特撮 > 国内アニメ');
        expect(genreLabel({ lv1: 0, lv2: 1 })).toBe('ニュース／報道 > 天気');
    });

    test('中分類が引けなければ大分類だけ出す', () => {
        // CS では un1/un2 に独自の値が入り、中分類が表に無いことがある
        expect(genreLabel({ lv1: 3, lv2: 9 })).toBe('ドラマ');
    });

    test('未定義の大分類は出さない', () => {
        // 0xC/0xD は予備。名前を作って出すと嘘になる
        expect(genreLabel({ lv1: 0xc, lv2: 0 })).toBe('');
    });
});

describe('audioLabel', () => {
    test('構成と言語を並べる', () => {
        expect(audioLabel({ componentType: 3, langs: ['jpn'] })).toBe('ステレオ (日本語)');
        expect(audioLabel({ componentType: 2, langs: ['jpn', 'eng'] })).toBe('デュアルモノ (日本語/英語)');
        expect(audioLabel({ componentType: 9, langs: ['jpn'] })).toBe('5.1ch (日本語)');
    });

    test('言語が無ければ構成だけ', () => {
        expect(audioLabel({ componentType: 1 })).toBe('モノラル');
    });

    test('知らない種別は番号のまま残す', () => {
        expect(audioLabel({ componentType: 99, langs: ['xyz'] })).toBe('種別99 (xyz)');
    });
});

describe('videoLabel', () => {
    test('解像度と符号化方式を並べる', () => {
        expect(videoLabel('1080i', 'mpeg2')).toBe('1080i MPEG-2');
        expect(videoLabel('480i', 'h.264')).toBe('480i H.264');
    });

    test('片方しか無ければあるほうだけ', () => {
        expect(videoLabel('1080i', null)).toBe('1080i');
        expect(videoLabel(null, 'mpeg2')).toBe('MPEG-2');
        expect(videoLabel(null, null)).toBe('');
    });
});
