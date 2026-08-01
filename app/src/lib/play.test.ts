import { describe, expect, test } from 'bun:test';
import { base64Url, detectPlatform, playLinks } from './play';

const URL = 'http://denpa.local/api/recordings/12/file';

describe('detectPlatform', () => {
    test('端末を見分ける', () => {
        expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
        expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
        expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
        expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other');
    });
});

describe('base64Url', () => {
    test('パディングを付けず、+/ を -_ に置き換える', () => {
        expect(base64Url('a')).toBe('YQ');
        expect(base64Url(URL)).not.toContain('=');
        expect(base64Url(URL)).not.toMatch(/[+/]/);
        expect(atob(base64Url(URL).replace(/-/g, '+').replace(/_/g, '/'))).toBe(URL);
    });
});

describe('playLinks', () => {
    test('Windows は mpv-handler のスキームで開く', () => {
        const [link] = playLinks(URL, 'windows');
        expect(link.href).toBe(`mpv://play/${base64Url(URL)}/`);
        // 入っていないと開けないので、それが分かるようにしておく
        expect(link.note).toContain('mpv-handler');
    });

    test('Android は VLC と mpv-android の両方を出す', () => {
        const links = playLinks(URL, 'android');
        expect(links.map((l) => l.href)).toEqual([
            `vlc://${URL}`,
            'intent://denpa.local/api/recordings/12/file#Intent;scheme=http;package=is.xyz.mpv;end',
        ]);
    });

    test('iOS は x-callback-url でURLを渡す', () => {
        const links = playLinks(URL, 'ios');
        expect(links[0].href).toContain('vlc-x-callback://x-callback-url/stream?url=');
        expect(links[1].href).toContain('infuse://x-callback-url/play?url=');
        for (const link of links) expect(link.href).toContain(encodeURIComponent(URL));
    });

    test('判定できない端末には素のURLを出す', () => {
        expect(playLinks(URL, 'other')).toEqual([{ label: 'ファイルを開く', href: URL }]);
    });
});
