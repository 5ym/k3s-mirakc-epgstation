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
 * 再生リンク。`url` は録画ファイルの絶対URL、`title` は番組名。
 *
 * Android は「動画を開く」インテントを投げて、どのアプリで開くかは端末に選ばせる。
 * アプリを名指しすると入っていないときに何も起きないうえ、好みも人それぞれなので、
 * 選択は端末の役目にする。
 *
 * iOS には同じ仕組みが無く、アプリごとの URL スキームを直に叩くしかない。
 * Windows も同様で、mpv-handler (https://github.com/akiirui/mpv-handler) が要る。
 */
export function playLinks(
    url: string,
    title: string,
    platform: Platform,
    credentials?: { user: string; password: string },
): PlayLink[] {
    // プレイヤーはベーシック認証のダイアログを出せないものが多いので、
    // URL に埋めて渡す。埋められないもの(Android の intent)は素のURLのまま
    const withCredentials =
        credentials === undefined
            ? url
            : url.replace(
                  /^(https?:\/\/)/,
                  `$1${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@`,
              );
    const encodedUrl = encodeURIComponent(withCredentials);
    const encodedTitle = encodeURIComponent(title);

    if (platform === 'windows') {
        // mpv-handler://PLUGINS/ENCODED_URL/?PARAMETERS=VALUES
        // URL もタイトルもパディング無しの base64url。スキームは mpv-handler で、
        // mpv:// は 0.3 までの古い名前(いま渡しても何も起きない)
        return [
            {
                label: 'mpv で再生',
                href: `mpv-handler://play/${base64Url(withCredentials)}/?v_title=${base64Url(title)}`,
                note: 'mpv-handler が必要',
            },
        ];
    }
    if (platform === 'android') {
        // scheme は Intent 側に持たせるので、URL からは取り除いて渡す。
        // S.title は VLC・mpv-android とも見てくれる
        const scheme = url.startsWith('https') ? 'https' : 'http';
        const rest = url.replace(/^https?:\/\//, '');
        return [
            {
                label: '動画アプリで再生',
                href:
                    `intent://${rest}#Intent;scheme=${scheme};` +
                    `action=android.intent.action.VIEW;type=video/*;` +
                    `S.title=${encodedTitle};end`,
                note: 'どのアプリで開くかは端末が聞いてきます',
            },
        ];
    }
    if (platform === 'ios') {
        return [
            {
                label: 'VLC で再生',
                href: `vlc-x-callback://x-callback-url/stream?url=${encodedUrl}`,
            },
            {
                label: 'Infuse で再生',
                href: `infuse://x-callback-url/play?url=${encodedUrl}&name=${encodedTitle}`,
            },
        ];
    }
    // 判定できない端末には、プレイヤーに貼れる素のURLだけ出す
    return [{ label: 'ファイルを開く', href: url }];
}
