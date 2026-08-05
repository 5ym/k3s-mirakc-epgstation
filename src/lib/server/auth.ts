import { enabled as oidcEnabled } from './oidc';
import { settings } from './settings';

/**
 * 誰を通すか。**口によって守り方が違う。**
 *
 * | 口 | 守り方 |
 * | --- | --- |
 * | `/api/recordings/<id>/file` と `/dav` | **ベーシック認証だけ** |
 * | それ以外 | OIDC (設定してあれば)。無ければベーシック認証 |
 * | `/login` まわり | 素通し (ここを守ると入口が無くなる) |
 *
 * **プレイヤーはリダイレクトを扱えない。** VLC も Kodi も Infuse も、ログイン画面へ
 * 飛ばされたところで何もできず「再生できません」で終わる。だからファイルを取りに
 * 来る口だけは、前段に何を置いていようと素のベーシック認証のまま残してある。
 */

/** ベーシック認証で守る口。**ここは OIDC にしない** */
const FILE_PATHS = [/^\/api\/recordings\/\d+\/file$/, /^\/dav(\/|$)/];

/** ログインの入口。守ると入れなくなる */
const OPEN_PATHS = [/^\/login(\/|$)/, /^\/logout$/];

export function isFilePath(pathname: string): boolean {
    return FILE_PATHS.some((pattern) => pattern.test(pathname));
}

export function isOpenPath(pathname: string): boolean {
    return OPEN_PATHS.some((pattern) => pattern.test(pathname));
}

export function enabled(): boolean {
    const { basicAuthUser, basicAuthPassword } = settings();
    return basicAuthUser !== '' && basicAuthPassword !== '';
}

/**
 * ベーシック認証で守る口か。
 *
 * **OIDC を入れると、画面のぶんは OIDC に譲る。** 両方掛けると、ブラウザの
 * 認証ダイアログを閉じないとログイン画面にすら行けない。`BASIC_AUTH_SCOPE=all`
 * を入れたままでもそうする (ファイルの口の扱いは変わらない)。
 */
export function protects(pathname: string): boolean {
    if (!enabled()) return false;
    if (isOpenPath(pathname)) return false;
    if (isFilePath(pathname)) return true;
    return settings().basicAuthScope === 'all' && !oidcEnabled();
}

/** OIDC でログインを求める口か */
export function needsLogin(pathname: string): boolean {
    if (!oidcEnabled()) return false;
    if (isOpenPath(pathname)) return false;
    return !isFilePath(pathname);
}

/** 長さの違いで早く返らないよう、桁数を揃えてから全桁比較する */
function sameSecret(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export function authorized(header: string | null): boolean {
    if (header === null || !header.startsWith('Basic ')) return false;
    let decoded: string;
    try {
        // atob はバイト列を Latin-1 として返す。日本語のパスワードだと
        // そのままでは元の文字列に戻らないので、UTF-8 として読み直す
        const binary = atob(header.slice('Basic '.length));
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        decoded = new TextDecoder().decode(bytes);
    } catch {
        return false;
    }
    // パスワードに : が入っていることがあるので、最初の : だけで割る
    const at = decoded.indexOf(':');
    if (at < 0) return false;
    const user = decoded.slice(0, at);
    const password = decoded.slice(at + 1);
    const current = settings();
    return sameSecret(user, current.basicAuthUser) && sameSecret(password, current.basicAuthPassword);
}

export function challenge(): Response {
    return new Response('authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="denpa", charset="UTF-8"' },
    });
}
