import { describe, expect, test } from 'bun:test';
import { base64Url, detectPlatform, playLinks, withCredentials } from './play';

const TITLE = 'テストアニメ 第1話';

const URL = 'http://denpa.local/api/recordings/12/file';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

describe('detectPlatform', () => {
    test('端末を見分ける', () => {
        expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
        expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
        expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
        expect(detectPlatform(MAC_UA)).toBe('mac');
        expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other');
    });

    test('iPadOS は Macintosh を名乗るのでタッチ点数で分ける', () => {
        // 渡す先が違う (Mac は denpa://、iPad は vlc-x-callback://)
        expect(detectPlatform(MAC_UA, 5)).toBe('ios');
        expect(detectPlatform(MAC_UA, 0)).toBe('mac');
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
function schemeUrl(href: string): string {
    return href.replace('denpa://play/', '').replace(/\/\?.*$/, '');
}

describe('playLinks', () => {
    test('Windows は denpa 自前のスキームで開く', () => {
        // Windows には Android の intent のような仕組みが無い
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

    test('Mac も Windows と同じリンクを出す', () => {
        // 受け口 (mac/denpa.sh と windows/denpa.ps1) が違うだけで、リンクの形は同じ
        const [mac] = playLinks(URL, TITLE, 'mac');
        const [windows] = playLinks(URL, TITLE, 'windows');
        expect(mac.href).toBe(windows.href);
        expect(mac.note).toContain('denpa.sh');
    });

    test('iOS は VLC 決め打ち', () => {
        // どのアプリで開くか選ばせる仕組みが iOS に無いので、1つに絞る
        const links = playLinks(URL, TITLE, 'ios');
        expect(links).toHaveLength(1);
        expect(links[0].href).toContain('vlc-x-callback://x-callback-url/stream?url=');
        expect(links[0].href).toContain(encodeURIComponent(URL));
    });

    test('判定できない端末には素のURLを出す', () => {
        expect(playLinks(URL, TITLE, 'other')).toEqual([{ label: 'ファイルを開く', href: URL }]);
    });
});

describe('ベーシック認証つきのURL', () => {
    const cred = { user: 'denpa', password: 'p@ss word' };

    test('Android の intent にも埋める', () => {
        // 資格情報は authority の一部なので、scheme を外しても残る
        const [link] = playLinks(URL, TITLE, 'android', cred);
        expect(link.href).toContain('intent://denpa:p%40ss%20word@denpa.local/');
        expect(link.href).toContain('scheme=http;');
    });

    test('Windows のスキームには資格情報を埋めたURLを渡す', () => {
        const [link] = playLinks(URL, TITLE, 'windows', cred);
        const decoded = atob(schemeUrl(link.href).replace(/-/g, '+').replace(/_/g, '/'));
        expect(decoded).toBe('http://denpa:p%40ss%20word@denpa.local/api/recordings/12/file');
    });

    test('iOS のスキームにも埋める', () => {
        for (const link of playLinks(URL, TITLE, 'ios', cred)) {
            // searchParams が一段解いてくれる。中身は資格情報つきのURLそのもの
            const url = new globalThis.URL(link.href).searchParams.get('url') ?? '';
            expect(url).toBe('http://denpa:p%40ss%20word@denpa.local/api/recordings/12/file');
        }
    });

    test('ダウンロード用のURLにも同じように埋められる', () => {
        // ブラウザは画面を開いたときの認証をダウンロードに引き継がない
        expect(withCredentials('http://denpa.local/api/recordings/12/file?download=1', cred)).toBe(
            'http://denpa.local/api/recordings/12/file?download=1'.replace(
                'http://',
                'http://denpa:p%40ss%20word@',
            ),
        );
    });

    test('資格情報が無ければ素のURLのまま', () => {
        const [link] = playLinks(URL, TITLE, 'windows');
        expect(atob(schemeUrl(link.href))).toBe(URL);
    });
});
