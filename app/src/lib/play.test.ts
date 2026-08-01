import { describe, expect, test } from 'bun:test';
import { base64Url, detectPlatform, playLinks } from './play';

const TITLE = 'テストアニメ 第1話';

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

/** denpa://play/<ここ>/?... を取り出す */
function mpvUrl(href: string): string {
    return href.replace('denpa://play/', '').replace(/\/\?.*$/, '');
}

describe('playLinks', () => {
    test('Windows は denpa 自前のスキームで開く', () => {
        const [link] = playLinks(URL, TITLE, 'windows');
        expect(link.href).toBe(`denpa://play/${base64Url(URL)}/?title=${base64Url(TITLE)}`);
        // 登録しないと開けないので、それが分かるようにしておく
        expect(link.note).toContain('denpa.ps1');
    });

    test('Android はアプリを名指しせず、端末に選ばせる', () => {
        const [link] = playLinks(URL, TITLE, 'android');
        // package= を付けるとそのアプリが無いときに何も起きない。
        // ACTION_VIEW + type だけ渡して、選択は端末に任せる
        expect(link.href).not.toContain('package=');
        expect(link.href).toContain('action=android.intent.action.VIEW');
        expect(link.href).toContain('type=video/*');
        expect(link.href).toContain('scheme=http');
        expect(link.href).toContain(`S.title=${encodeURIComponent(TITLE)}`);
    });

    test('iOS は x-callback-url でURLを渡す', () => {
        const links = playLinks(URL, TITLE, 'ios');
        expect(links[0].href).toContain('vlc-x-callback://x-callback-url/stream?url=');
        expect(links[1].href).toContain('infuse://x-callback-url/play?url=');
        for (const link of links) expect(link.href).toContain(encodeURIComponent(URL));
        // 番組名を渡せるものには渡す
        expect(links[1].href).toContain(`name=${encodeURIComponent(TITLE)}`);
    });

    test('判定できない端末には素のURLを出す', () => {
        expect(playLinks(URL, TITLE, 'other')).toEqual([{ label: 'ファイルを開く', href: URL }]);
    });
});

describe('ベーシック認証つきのURL', () => {
    const cred = { user: 'denpa', password: 'p@ss word' };

    test('mpv には資格情報を埋めたURLを渡す', () => {
        const [link] = playLinks(URL, TITLE, 'windows', cred);
        const decoded = atob(mpvUrl(link.href).replace(/-/g, '+').replace(/_/g, '/'));
        expect(decoded).toBe('http://denpa:p%40ss%20word@denpa.local/api/recordings/12/file');
    });

    test('iOS のスキームにも埋める', () => {
        const links = playLinks(URL, TITLE, 'ios', cred);
        for (const link of links) {
            // searchParams が一段解いてくれる。中身は資格情報つきのURLそのもの
            const url = new globalThis.URL(link.href).searchParams.get('url') ?? '';
            expect(url).toBe('http://denpa:p%40ss%20word@denpa.local/api/recordings/12/file');
        }
    });

    test('資格情報が無ければ素のURLのまま', () => {
        const [link] = playLinks(URL, TITLE, 'windows');
        expect(atob(mpvUrl(link.href))).toBe(URL);
    });
});
