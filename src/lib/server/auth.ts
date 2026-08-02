import { settings } from './settings';

/**
 * ベーシック認証。
 *
 * mpv も Kodi も、画面の前段に置く forward-auth のようなリダイレクト型の認証は扱えない。
 * かといってファイルを誰でも取れる状態にはしたくないので、
 * 「ファイルを取りに来る口だけ」に素のベーシック認証をかけられるようにしてある。
 */

/** 認証をかける口。範囲が files のときはここだけ見る */
const FILE_PATHS = [/^\/api\/recordings\/\d+\/file$/, /^\/dav(\/|$)/];

export function enabled(): boolean {
    const { basicAuthUser, basicAuthPassword } = settings();
    return basicAuthUser !== '' && basicAuthPassword !== '';
}

export function protects(pathname: string): boolean {
    if (!enabled()) return false;
    if (settings().basicAuthScope === 'all') return true;
    return FILE_PATHS.some((pattern) => pattern.test(pathname));
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
