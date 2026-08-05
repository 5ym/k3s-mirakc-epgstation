/**
 * OIDC (認可コードフロー + PKCE) でのログイン。
 *
 * **ライブラリを入れていません。** 使う口は discovery・authorize・token・jwks の
 * 4つだけで、どれも素の HTTP と WebCrypto で足ります。依存を増やすほうが、
 * 認証まわりで「中で何をしているか分からない」を抱えることになります。
 *
 * 相手は Entra ID を想定していますが、OIDC の標準しか使っていないので
 * Keycloak でも Google でも同じはずです (実機で当てたのは Entra だけ)。
 *
 * **ここは「誰か」を確かめるだけ**で、通すかどうかは `auth.ts` が決めます。
 */

import { config } from './config';

/** 有効かどうか。3つ揃っていなければ、今までどおり前段の認証に任せる */
export function enabled(): boolean {
    return config.oidcIssuer !== '' && config.oidcClientId !== '' && config.oidcClientSecret !== '';
}

export interface Discovery {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    end_session_endpoint?: string;
}

/**
 * 相手の口の一覧。**一度読んだら覚えておきます。**
 *
 * 鍵の入れ替えと違って口の場所は動かないので、毎回取りに行く理由がありません。
 * 取れなかったときは覚えないので、次のログインでもう一度取りに行きます。
 */
let discovered: Discovery | null = null;

export async function discover(fetcher: typeof fetch = fetch): Promise<Discovery> {
    if (discovered !== null) return discovered;
    const url = `${config.oidcIssuer}/.well-known/openid-configuration`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`OIDC の設定を読めません (${res.status}) ${url}`);
    const doc = (await res.json()) as Partial<Discovery>;
    for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
        if (typeof doc[key] !== 'string') throw new Error(`OIDC の設定に ${key} がありません`);
    }
    discovered = doc as Discovery;
    return discovered;
}

/** 試験用。覚えているものを捨てる */
export function forget(): void {
    discovered = null;
    keys.clear();
}

const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** 推測できない文字列。state・nonce・セッションIDに使う */
export function randomToken(bytes = 32): string {
    return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE の合言葉。S256 しか使いません (plain は相手が受けても使わない) */
export async function challengeOf(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
    return base64Url(new Uint8Array(digest));
}

export interface Pending {
    state: string;
    nonce: string;
    verifier: string;
    /** ログインし終わったら戻る先 */
    to: string;
}

/**
 * 戻る先。**自分のところの絶対パスだけ**受ける。
 *
 * そのまま使うと `?to=//evil.example` で外へ飛ばす踏み台になる
 * (`//` で始まる URL は「同じ scheme の別ホスト」を指す)。
 */
export function safeReturn(to: string | null): string {
    if (to === null || !to.startsWith('/') || to.startsWith('//')) return '/';
    return to;
}

/**
 * 戻ってくる口の住所。**Entra のアプリ登録に、名前ごとに1つずつ足しておくこと。**
 *
 * denpa には名前が2つある (`dp.doany.io` と `dp.l.doany.io`) ので、決め打ちにせず
 * 来たリクエストから組み立てる。**認可のときと引き換えのときで同じ値**を渡す
 * 必要があるので、両方ここから取る
 */
export function redirectUri(origin: string): string {
    return new URL('/login/callback', origin).toString();
}

/** 預けておいた途中の控えを読み直す。壊れていれば null (最初からやり直させる) */
export function readPending(raw: string | undefined): Pending | null {
    if (raw === undefined) return null;
    try {
        const value = JSON.parse(raw) as Partial<Pending>;
        const ok = (['state', 'nonce', 'verifier', 'to'] as const).every(
            (key) => typeof value[key] === 'string' && value[key] !== '',
        );
        return ok ? (value as Pending) : null;
    } catch {
        return null;
    }
}

export async function start(redirectUri: string, to: string): Promise<{ url: string; pending: Pending }> {
    const doc = await discover();
    const pending: Pending = {
        state: randomToken(),
        nonce: randomToken(),
        verifier: randomToken(),
        to,
    };
    const params = new URLSearchParams({
        client_id: config.oidcClientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        // groups は openid だけで載る (アプリ登録側の設定次第)。profile は表示名のため
        scope: 'openid profile',
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: await challengeOf(pending.verifier),
        code_challenge_method: 'S256',
    });
    return { url: `${doc.authorization_endpoint}?${params}`, pending };
}

/**
 * 受け取ったコードを ID トークンに換える。
 *
 * **秘密はここでしか使いません。** 本文に入れて (`client_secret_post`) 送ります —
 * Entra はどちらも受けますが、ヘッダに入れる形は URL 符号化の解釈が実装で割れるので、
 * 迷いようのないほうにしてあります。
 */
async function exchange(code: string, redirectUri: string, verifier: string): Promise<string> {
    const doc = await discover();
    const res = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: config.oidcClientId,
            client_secret: config.oidcClientSecret,
            code_verifier: verifier,
        }),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error_description?: string };
    if (!res.ok || typeof body.id_token !== 'string') {
        throw new Error(`引き換えに失敗しました (${res.status}) ${body.error_description ?? ''}`.trim());
    }
    return body.id_token;
}

/** kid ごとの公開鍵。相手が鍵を入れ替えたときのために、見つからなければ取り直す */
const keys = new Map<string, CryptoKey>();

async function publicKey(kid: string): Promise<CryptoKey> {
    const cached = keys.get(kid);
    if (cached !== undefined) return cached;

    const doc = await discover();
    const res = await fetch(doc.jwks_uri);
    if (!res.ok) throw new Error(`鍵を読めません (${res.status})`);
    const { keys: jwks } = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    for (const jwk of jwks ?? []) {
        if (jwk.kid === undefined || jwk.kty !== 'RSA') continue;
        const key = await crypto.subtle.importKey(
            'jwk',
            { ...jwk, key_ops: ['verify'], ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            true,
            ['verify'],
        );
        keys.set(jwk.kid, key);
    }
    const found = keys.get(kid);
    if (found === undefined) throw new Error(`ID トークンの鍵 (${kid}) が見つかりません`);
    return found;
}

export interface Claims {
    sub: string;
    name?: string;
    preferred_username?: string;
    email?: string;
    groups?: string[];
    /** グループが多すぎて載せられなかったときに Entra が入れてくる印 */
    _claim_names?: Record<string, string>;
    iss: string;
    aud: string | string[];
    exp: number;
    nbf?: number;
    nonce?: string;
}

/** 時計のずれの許容 (秒)。RFC 7519 が「小さめに」と言っている程度 */
const SKEW = 60;

/**
 * ID トークンを開いて中身を確かめる。
 *
 * **署名まで見ます。** 認可コードフローでは TLS 越しに相手から直に受け取るので
 * 仕様上は省いてもよいことになっていますが (OIDC Core 3.1.3.7)、
 * 省いた実装は「トークンをどこから受け取ったか」に安全が乗ります。
 * WebCrypto で数行なので、乗せる理由がありません。
 */
export async function verify(token: string, nonce: string, at = Date.now()): Promise<Claims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('ID トークンの形が違います');
    const [rawHeader, rawPayload, rawSignature] = parts;

    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(rawHeader))) as {
        alg?: string;
        kid?: string;
    };
    // alg は相手が決めるものだが、こちらが受けるのは RS256 だけ。
    // none を受けると署名を見ない道ができてしまう
    if (header.alg !== 'RS256') throw new Error(`受けられない署名方式です (${header.alg})`);
    if (typeof header.kid !== 'string') throw new Error('ID トークンに鍵の名前がありません');

    const ok = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        await publicKey(header.kid),
        decodeBase64Url(rawSignature),
        encoder.encode(`${rawHeader}.${rawPayload}`),
    );
    if (!ok) throw new Error('ID トークンの署名が合いません');

    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(rawPayload))) as Claims;
    const doc = await discover();
    if (claims.iss !== doc.issuer) throw new Error('ID トークンの発行元が違います');

    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(config.oidcClientId)) throw new Error('ID トークンの宛先が違います');

    const seconds = Math.floor(at / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + SKEW < seconds) {
        throw new Error('ID トークンの期限が切れています');
    }
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW > seconds) {
        throw new Error('ID トークンがまだ有効ではありません');
    }
    // 出したときの合言葉と一致すること。これが「自分が始めたログイン」の証拠になる
    if (claims.nonce !== nonce) throw new Error('ID トークンの合言葉が合いません');
    if (typeof claims.sub !== 'string' || claims.sub === '')
        throw new Error('ID トークンに sub がありません');
    return claims;
}

/**
 * 通していい人か。**居るグループで決めます** (誰がログインしたかでは決めない)。
 *
 * `OIDC_GROUP` が空なら、入れた人は全員通します。
 */
export function allowed(claims: Claims): { ok: true } | { ok: false; reason: string } {
    if (config.oidcGroup === '') return { ok: true };

    if (claims.groups === undefined) {
        /*
         * **グループが多い人はここに来ます。** Entra はクレームが大きくなりすぎると
         * `groups` の代わりに `_claim_names` を入れて「Graph を叩いて取れ」と言う。
         * 黙って弾くと「なぜか自分だけ入れない」になるので、理由を出す
         */
        const overflow = claims._claim_names?.groups !== undefined;
        return {
            ok: false,
            reason: overflow
                ? 'グループが多すぎて ID トークンに載っていません (Entra の _claim_names)'
                : 'ID トークンに groups がありません (アプリ登録の groupMembershipClaims を有効にしてください)',
        };
    }
    if (!claims.groups.includes(config.oidcGroup)) {
        return { ok: false, reason: `${config.oidcGroup} のグループに入っていません` };
    }
    return { ok: true };
}

/** 画面に出す名前。無ければ空文字 (誰であるかは sub が持っている) */
export function displayName(claims: Claims): string {
    return claims.name ?? claims.preferred_username ?? claims.email ?? '';
}

/** 受け取ったコードを確かめ切って、中身を返す */
export async function complete(
    code: string,
    redirectUri: string,
    pending: Pending,
): Promise<{ subject: string; name: string }> {
    const token = await exchange(code, redirectUri, pending.verifier);
    const claims = await verify(token, pending.nonce);
    const verdict = allowed(claims);
    if (!verdict.ok) throw new Error(verdict.reason);
    return { subject: claims.sub, name: displayName(claims) };
}
