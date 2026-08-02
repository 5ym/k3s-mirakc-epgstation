/**
 * 録画を外部プレイヤーで開くためのURLを組み立てる。
 *
 * ブラウザは MPEG-2 も AV1+Opus の mkv も素直には再生できないので、
 * 再生は端末に入っているプレイヤーに任せ、denpa は「このURLを開け」と渡すだけにする。
 * サーバ側で作らず、ブラウザで作る(どの端末から見ているかで渡し先が変わるため)。
 */

export type Platform = 'windows' | 'mac' | 'android' | 'ios' | 'other';

/**
 * User-Agent から、どのスキームを出すか決めるためだけの雑な判定。
 *
 * iPadOS は Macintosh を名乗るので、UA だけでは Mac と見分けられない。
 * 渡す口が違う(Mac は denpa://、iPad は vlc-x-callback://)ので、
 * タッチ点数で分ける。Mac のトラックパッドは maxTouchPoints 0 になる。
 */
export function detectPlatform(userAgent: string, touchPoints = 0): Platform {
    const ua = userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    if (/windows/.test(ua)) return 'windows';
    if (/macintosh|mac os x/.test(ua)) return touchPoints > 1 ? 'ios' : 'mac';
    return 'other';
}

/** パディング無しの base64url (RFC 4648 §5)。denpa:// のリンクで使う */
export function base64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * ベーシック認証の資格情報を URL に埋める。
 *
 * プレイヤーは認証ダイアログを出せないものが多く、ブラウザからの
 * ダウンロードもページの資格情報を引き継がないので、URL に入れるしかない。
 */
export function withCredentials(url: string, credentials?: { user: string; password: string }): string {
    if (credentials === undefined) return url;
    return url.replace(
        /^(https?:\/\/)/,
        `$1${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@`,
    );
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
 * Android だけは「動画を開く」インテントを投げて、どのアプリで開くかを端末に選ばせられる。
 * アプリを名指しすると入っていないときに何も起きないうえ、好みも人それぞれなので、
 * 選択は端末の役目にする。
 *
 * **他の端末にこれに当たる仕組みは無い。** リンクから開けるのは「そのスキームを
 * 登録しているアプリ」だけで、選択画面を出す方法がない(iOS の共有シートはリンクからは
 * 呼べない)。そのため Windows・Mac・iOS は VLC 決め打ちにしてある。
 *
 * Windows と Mac は VLC 自身がスキームを持たないので、denpa:// を自前で用意して
 * windows/denpa.ps1・mac/denpa.sh で登録する。リンクの形は両者で同じ。
 */
export function playLinks(
    url: string,
    title: string,
    platform: Platform,
    credentials?: { user: string; password: string },
): PlayLink[] {
    // 埋められないもの(Android の intent)は素のURLのまま
    const authed = withCredentials(url, credentials);
    const encodedUrl = encodeURIComponent(authed);
    const encodedTitle = encodeURIComponent(title);

    if (platform === 'windows' || platform === 'mac') {
        /*
         * denpa 自前のスキーム。登録役が VLC に渡す。
         *
         * URL もタイトルもパディング無しの base64url にする。生のURLを
         * クエリに入れると、資格情報の @ や記号でブラウザ側の解釈がぶれる
         */
        return [
            {
                label: '再生',
                href: `denpa://play/${base64Url(authed)}/?title=${base64Url(title)}`,
                note: platform === 'windows' ? 'windows/denpa.ps1 で登録が必要' : 'mac/denpa.sh で登録が必要',
            },
        ];
    }
    if (platform === 'android') {
        // scheme は Intent 側に持たせるので、URL からは取り除いて渡す。
        // 資格情報は authority の一部なので、取り除いたあとにも残る
        // (user:pass@host/... の形)。S.title は VLC も MX Player も見てくれる
        const scheme = url.startsWith('https') ? 'https' : 'http';
        const rest = authed.replace(/^https?:\/\//, '');
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
        // VLC 決め打ち。iOS はリンクから「どのアプリで開くか」を選ばせられない
        return [{ label: 'VLC で再生', href: `vlc-x-callback://x-callback-url/stream?url=${encodedUrl}` }];
    }
    // 判定できない端末には、プレイヤーに貼れる素のURLだけ出す
    return [{ label: 'ファイルを開く', href: url }];
}
