import { config } from './config';
import { enabled as oidcEnabled } from './oidc';
import { saveSettings, settings } from './settings';

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
 *
 * **適用範囲の設定は持たない。** 以前は「配信と WebDAV だけ / 画面も含めて全部」を
 * 選べたが、既定 (files) のままだと**画面が誰にでも開く**。前段に別の認証を
 * 置いている構成でしか成り立たない既定で、しかも掛かっているつもりでいられた。
 * いまは掛けたら全部に掛かる (OIDC があるところだけ、そちらに譲る)。
 */

/**
 * ベーシック認証のユーザー名。**変えられない。**
 *
 * 変えて嬉しいことが何も無い。プレイヤー側にも同じものを入れる必要があるだけで、
 * 忘れると登録済みの端末が全部つながらなくなる。
 */
export const BASIC_AUTH_USER = 'denpa';

/**
 * パスワードに使う文字。
 *
 * 記号は入れない。このパスワードは**再生リンクのURLに埋め込まれる**ので、
 * `:` `@` `/` `#` `?` が入ると URL として割れてしまう。
 * 紛らわしい文字 (0/O、1/l/I) も外す。Kodi の画面で手入力することがある
 */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 24;

export function generatePassword(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_LENGTH));
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * **起動時に、無ければ作る。**
 *
 * 何も設定しないまま立てると、録画も WebDAV も誰でも取れる状態で上がっていた。
 * 「あとで設定画面から掛ける」は忘れるし、忘れたことに気付く手立てが無い。
 *
 * **作ったパスワードはログに1度だけ出す。** 掛かった以上どこかで受け取れないと、
 * 立てた本人が自分の画面に入れない。以降は設定画面から見る (OIDC を設定して
 * あれば Entra で入って読める。無ければここのログが唯一の手掛かり)。
 */
export function ensureBasicAuth(): boolean {
    if (enabled()) return false;
    const password = generatePassword();
    saveSettings({ basicAuthUser: BASIC_AUTH_USER, basicAuthPassword: password });
    console.log(
        `[boot] ベーシック認証を作りました: ${BASIC_AUTH_USER} / ${password}\n` +
            '       設定画面から見直せます。プレイヤー (VLC / Kodi) にも同じものを入れてください',
    );
    return true;
}

/** ベーシック認証で守る口。**ここは OIDC にしない** */
const FILE_PATHS = [/^\/api\/recordings\/\d+\/file$/, /^\/dav(\/|$)/];

/**
 * 素通しにする口。
 *
 * - **ログインの入口。** 守ると入れなくなる (ログイン画面へ行くのにログインが要る)
 * - **`/api/health`。** Kubernetes の `livenessProbe` が叩く。守ると**Pod が
 *   再起動を繰り返す** (掛ける範囲を選べるのをやめたときに実際に踏んだ —
 *   E2E のスタックが起動待ちで固まった)。出しているのは
 *   「生きているか・局が何件か・録画が何本か」だけ
 * - **`/manifest.webmanifest`。** ブラウザは**資格情報を付けずに**取りに行く
 *   ので (`<link rel="manifest">` に `crossorigin` を書かない限り)、守ると
 *   ホーム画面に置けなくなる。static に置いてあった頃は adapter-node が
 *   hooks より手前で返していて、そもそも掛かっていなかった。出しているのは
 *   アプリの名前とアイコンの場所だけ
 */
const OPEN_PATHS = [/^\/login(\/|$)/, /^\/logout$/, /^\/api\/health$/, /^\/manifest\.webmanifest$/];

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
 * ベーシック認証で守る口か。**掛けたら全部に掛かる。**
 *
 * 唯一の例外が OIDC で、**画面のぶんはそちらに譲る**。両方掛けると、ブラウザの
 * 認証ダイアログを閉じないとログイン画面にすら行けない。ファイルの口は
 * どちらにせよベーシック認証のままなので、守りに穴は空かない。
 */
export function protects(pathname: string): boolean {
    if (!enabled()) return false;
    if (isOpenPath(pathname)) return false;
    if (isFilePath(pathname)) return true;
    return !oidcEnabled();
}

/**
 * **何も聞かずに通す相手か。** 見るのは住所だけ (`TRUSTED_NETWORKS`、CIDR の
 * カンマ区切り)。
 *
 * **ここに当たるとベーシック認証も OIDC も掛かりません。** プレイヤー
 * (VLC / Kodi / Infuse) に資格情報を入れずに使えるのが狙いです。
 *
 * **どの名前で来たかは問いません。** 名前で分けるのは前段 (Traefik) の仕事で、
 * LAN 用の名前には `ClientIP` を条件に付けてあります。ここで名前も見ると
 * 同じ条件を二か所に書くことになり、片方だけ直して食い違うほうが危ない。
 */
export function trusted(address: string): boolean {
    return entries().some((network) => inNetwork(address, network));
}

function entries(): string[] {
    return config.trustedNetworks
        .split(',')
        .map((raw) => raw.trim())
        .filter((raw) => raw !== '');
}

/**
 * 住所がその網の中か。IPv4 の CIDR (`10.10.0.0/16`) か、そのままの住所。
 * **IPv6 は書いたとおりに一致したときだけ**通す (前置き長での判定は入れていない)。
 */
export function inNetwork(address: string, entry: string): boolean {
    // ::ffff:10.0.0.1 のような書き方で届くことがある
    const target = address.replace(/^::ffff:/i, '');
    const [network, bits] = entry.split('/');
    const left = toIpv4(target);
    const right = toIpv4(network.replace(/^::ffff:/i, ''));
    if (left === null || right === null) return target === network;

    const length = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(length) || length < 0 || length > 32) return false;
    if (length === 0) return true;
    // >>> で符号なしに戻す。32bit シフトは 0 シフトになるので上で外してある
    const mask = (0xffffffff << (32 - length)) >>> 0;
    return (left & mask) >>> 0 === (right & mask) >>> 0;
}

function toIpv4(value: string): number | null {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const byte = Number(part);
        if (byte > 255) return null;
        out = ((out << 8) | byte) >>> 0;
    }
    return out;
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
