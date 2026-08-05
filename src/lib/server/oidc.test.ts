import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { config } from './config';
import { allowed, challengeOf, displayName, enabled, forget, verify } from './oidc';

/*
 * **`config` を直に差し替える。** 環境変数を入れてから import する手は使えない —
 * `config` は読み込んだ一度きりに環境変数を写すので、他の試験が先に読み込んでいると
 * こちらの環境変数は届かない (単体では通るのに、全部走らせると落ちる)
 */
const ISSUER = 'https://login.example/tenant/v2.0';
const CLIENT_ID = 'denpa-test-client';
const original = { ...config };

/** 署名に使う鍵。1回作って使い回す (作るのが試験の中で一番重い) */
const pair = await crypto.subtle.generateKey(
    {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
);
const KID = 'test-key';

function b64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
const encode = (value: object) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/** 相手が出す ID トークンを組み立てる。header を差し替えられるようにしてある */
async function idToken(claims: object, header: object = {}): Promise<string> {
    const head = encode({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
    const body = encode(claims);
    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

const NOW = Date.UTC(2026, 7, 5, 0, 0, 0);
const base = {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'user-1',
    name: 'Ruk Doe',
    nonce: 'nonce-1',
    exp: Math.floor(NOW / 1000) + 3600,
};

const realFetch = globalThis.fetch;
beforeEach(async () => {
    forget();
    config.oidcIssuer = ISSUER;
    config.oidcClientId = CLIENT_ID;
    config.oidcClientSecret = 'shhh';
    config.oidcGroup = 'admins';
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration')) {
            return Response.json({
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}/authorize`,
                token_endpoint: `${ISSUER}/token`,
                jwks_uri: `${ISSUER}/keys`,
            });
        }
        if (url.endsWith('/keys')) return Response.json({ keys: [{ ...jwk, kid: KID }] });
        throw new Error(`呼ばれるはずのない口: ${url}`);
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = realFetch;
    Object.assign(config, original);
    forget();
});

describe('設定してあるか', () => {
    test('3つ揃っていれば有効', () => {
        expect(enabled()).toBe(true);
    });
});

/*
 * **PKCE。** 合言葉そのものは送らず、SHA-256 を送ってから後で突き合わせる。
 * RFC 7636 の付録Aに載っている値で確かめる
 */
describe('PKCE の合言葉', () => {
    test('RFC 7636 の例と一致する', async () => {
        expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
            'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        );
    });
});

describe('ID トークンを確かめる', () => {
    test('正しいものは中身が読める', async () => {
        const claims = await verify(await idToken(base), 'nonce-1', NOW);
        expect(claims.sub).toBe('user-1');
        expect(displayName(claims)).toBe('Ruk Doe');
    });

    /*
     * **合言葉が「自分が始めたログイン」の証拠。** ここを見ないと、他所で発行された
     * 同じ相手のトークンを貼られたときに通してしまう
     */
    test('合言葉が違えば通さない', async () => {
        await expect(verify(await idToken(base), 'べつの', NOW)).rejects.toThrow('合言葉');
    });

    test('宛先が自分でなければ通さない', async () => {
        // 同じ Entra で発行された、別のアプリ向けのトークン
        await expect(verify(await idToken({ ...base, aud: 'someone-else' }), 'nonce-1', NOW)).rejects.toThrow(
            '宛先',
        );
    });

    test('発行元が違えば通さない', async () => {
        await expect(
            verify(await idToken({ ...base, iss: 'https://evil.example' }), 'nonce-1', NOW),
        ).rejects.toThrow('発行元');
    });

    test('期限が切れていれば通さない', async () => {
        const expired = { ...base, exp: Math.floor(NOW / 1000) - 3600 };
        await expect(verify(await idToken(expired), 'nonce-1', NOW)).rejects.toThrow('期限');
    });

    test('少しの時計のずれは許す', async () => {
        // 30秒前に切れたもの。ここで弾くと、時計が合っていない端末から入れなくなる
        const justExpired = { ...base, exp: Math.floor(NOW / 1000) - 30 };
        expect((await verify(await idToken(justExpired), 'nonce-1', NOW)).sub).toBe('user-1');
    });

    test('署名が合わなければ通さない', async () => {
        const token = await idToken(base);
        // 本文だけ差し替える。署名は元のまま
        const [head, , signature] = token.split('.');
        const forged = `${head}.${encode({ ...base, sub: 'someone-else' })}.${signature}`;
        await expect(verify(forged, 'nonce-1', NOW)).rejects.toThrow('署名');
    });

    /*
     * **`alg: none` を受けない。** 受けると「署名を見ない道」ができ、
     * 中身を好きに書いたトークンが通る。JWT の実装が繰り返し踏んでいる穴
     */
    test('RS256 以外は受けない', async () => {
        const head = encode({ alg: 'none', kid: KID });
        await expect(verify(`${head}.${encode(base)}.`, 'nonce-1', NOW)).rejects.toThrow('署名方式');
    });

    test('形が違えば通さない', async () => {
        await expect(verify('これはトークンではない', 'nonce-1', NOW)).rejects.toThrow('形');
    });
});

/*
 * **通すかどうかはグループで決める。** 誰がログインしたかでは決めない —
 * 人が増えたときに denpa 側を触らなくて済む
 */
describe('通していい人か', () => {
    test('入っていれば通す', () => {
        expect(allowed({ ...base, groups: ['others', 'admins'] })).toEqual({ ok: true });
    });

    test('入っていなければ断る', () => {
        const verdict = allowed({ ...base, groups: ['others'] });
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.reason).toContain('admins');
    });

    test('groups が無いときは、設定のどこを直すか出す', () => {
        // アプリ登録で groupMembershipClaims を有効にしていないとこうなる
        const verdict = allowed(base);
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.reason).toContain('groupMembershipClaims');
    });

    /*
     * グループが多い人はクレームに載らず、代わりに `_claim_names` が来る。
     * 「入っていない」と同じ扱いで黙って弾くと、なぜか自分だけ入れない状態になる
     */
    test('多すぎて載らなかったときは、そうと分かる理由を出す', () => {
        const verdict = allowed({ ...base, _claim_names: { groups: 'src1' } });
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.reason).toContain('多すぎて');
    });
});

describe('画面に出す名前', () => {
    test('name が無ければ別の名乗りを使う', () => {
        expect(displayName({ ...base, name: undefined, preferred_username: 'ruk@example' })).toBe(
            'ruk@example',
        );
        expect(displayName({ ...base, name: undefined })).toBe('');
    });
});
