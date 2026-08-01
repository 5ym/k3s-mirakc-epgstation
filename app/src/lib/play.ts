/**
 * 録画を外部プレイヤーで開くためのURLを組み立てる。
 *
 * ブラウザは MPEG-2 も AV1+Opus の mkv も素直には再生できないので、
 * 再生は端末に入っているプレイヤーに任せ、denpa は「このURLを開け」と渡すだけにする。
 * サーバ側で作らず、ブラウザで作る(どの端末から見ているかで渡し先が変わるため)。
 */

export type Platform = 'windows' | 'android' | 'ios' | 'other';

/** User-Agent から、どのスキームを出すか決めるためだけの雑な判定 */
export function detectPlatform(userAgent: string): Platform {
    const ua = userAgent.toLowerCase();
    // iPadOS は Macintosh を名乗るので、タッチの有無でしか見分けられない。
    // ここでは iPhone/iPad/iPod だけを iOS 扱いにする
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    if (/windows/.test(ua)) return 'windows';
    return 'other';
}

/** mpv-handler が要求する base64url (パディング無し) */
export function base64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PlayLink {
    label: string;
    href: string;
    /** ボタンの下に出す一言。入っていないと開けないものがあるため */
    note?: string;
}

/**
 * 再生リンク。`url` は録画ファイルの絶対URL。
 *
 * - Windows: mpv-handler (`mpv://play/<base64url>/`)。
 *   https://github.com/akiirui/mpv-handler を入れておく必要がある
 * - Android: VLC と mpv-android。mpv-android は intent:// でパッケージを名指しする
 * - iOS: VLC と Infuse。どちらも x-callback-url でURLを渡す
 */
export function playLinks(url: string, platform: Platform): PlayLink[] {
    const encoded = encodeURIComponent(url);

    if (platform === 'windows') {
        return [
            {
                label: 'mpv で再生',
                href: `mpv://play/${base64Url(url)}/`,
                note: 'mpv-handler が必要',
            },
        ];
    }
    if (platform === 'android') {
        return [
            { label: 'VLC で再生', href: `vlc://${url}` },
            {
                label: 'mpv で再生',
                // scheme を Intent 側に持たせるので、URL からは取り除いて渡す
                href: `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=${
                    url.startsWith('https') ? 'https' : 'http'
                };package=is.xyz.mpv;end`,
            },
        ];
    }
    if (platform === 'ios') {
        return [
            { label: 'VLC で再生', href: `vlc-x-callback://x-callback-url/stream?url=${encoded}` },
            { label: 'Infuse で再生', href: `infuse://x-callback-url/play?url=${encoded}` },
        ];
    }
    // 判定できない端末には、プレイヤーに貼れる素のURLだけ出す
    return [{ label: 'ファイルを開く', href: url }];
}
