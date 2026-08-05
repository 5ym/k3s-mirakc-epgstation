/**
 * 偽の Entra ID。
 *
 * denpa の OIDC を通しで試すためだけのもの。OIDC の口は4つしか使っていないので
 * (discovery / authorize / token / jwks)、そのぶんだけ本物のように振る舞う。
 * 鍵は起動のたびに作る。
 *
 * **人は出てこない。** `authorize` に来たらその場でコードを発行して戻す。
 * 「誰が入るか」は `FAKE_IDP_GROUPS` で決める — 通す人と断る人の両方を試すため。
 */
const PORT = Number(process.env.FAKE_IDP_PORT ?? 9876);
const ISSUER = process.env.FAKE_IDP_ISSUER ?? `http://127.0.0.1:${PORT}`;
const KID = 'fake-key';

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
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: KID };

const b64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
const encode = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));

/** どのグループに居ることにするか。テストから差し替える */
let groups = (process.env.FAKE_IDP_GROUPS ?? 'admins').split(',').filter(Boolean);
/** `groups` そのものを載せない。アプリ登録の設定漏れを再現する */
let omitGroups = false;

/** 発行したコード → そのときの nonce。token で載せ直す */
const codes = new Map<string, string>();

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    async fetch(request) {
        const url = new URL(request.url);

        // テストから振る舞いを変える口。本物には無い
        if (url.pathname === '/__control/groups' && request.method === 'POST') {
            const body = (await request.json()) as { groups?: string[]; omit?: boolean };
            groups = body.groups ?? groups;
            omitGroups = body.omit === true;
            return json({ ok: true, groups, omitGroups });
        }

        if (url.pathname === '/.well-known/openid-configuration') {
            return json({
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}/authorize`,
                token_endpoint: `${ISSUER}/token`,
                jwks_uri: `${ISSUER}/keys`,
            });
        }

        if (url.pathname === '/keys') return json({ keys: [jwk] });

        if (url.pathname === '/authorize') {
            const code = `code-${codes.size + 1}`;
            codes.set(code, url.searchParams.get('nonce') ?? '');
            const back = new URL(url.searchParams.get('redirect_uri') ?? `${ISSUER}/`);
            back.searchParams.set('code', code);
            back.searchParams.set('state', url.searchParams.get('state') ?? '');
            return new Response(null, { status: 302, headers: { location: back.toString() } });
        }

        if (url.pathname === '/token') {
            const form = new URLSearchParams(await request.text());
            const nonce = codes.get(form.get('code') ?? '');
            if (nonce === undefined) return json({ error_description: 'unknown code' }, 400);

            const head = encode({ alg: 'RS256', kid: KID, typ: 'JWT' });
            const body = encode({
                iss: ISSUER,
                aud: form.get('client_id'),
                sub: 'fake-user',
                name: 'テスト太郎',
                ...(omitGroups ? {} : { groups }),
                nonce,
                exp: Math.floor(Date.now() / 1000) + 600,
            });
            const signature = await crypto.subtle.sign(
                'RSASSA-PKCS1-v1_5',
                pair.privateKey,
                new TextEncoder().encode(`${head}.${body}`),
            );
            return json({
                token_type: 'Bearer',
                id_token: `${head}.${body}.${b64(new Uint8Array(signature))}`,
            });
        }

        return new Response('not found', { status: 404 });
    },
});

console.log(`fake idp listening on ${ISSUER}`);

// このファイルを「モジュール」にする。素のスクリプトだと他の偽物と名前がぶつかる
export {};
