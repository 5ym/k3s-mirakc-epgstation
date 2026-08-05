import { bootOidc, type OidcStack } from '../stack';
import { test as base, expect } from './helpers';

/**
 * OIDC でのログインと、網で素通しにする口。
 *
 * **普段の一式とは別に立てます。** `stack` を OIDC にしてしまうと、他の全部の
 * テストがログインを通らないと何もできなくなるため (`bootOidc`)。
 *
 * ブラウザは使いません。ログインの道は HTTP のやり取りそのものが仕様で、
 * 素の `fetch` のほうが「何を送って何が返ったか」をそのまま押さえられます。
 * Playwright の APIRequestContext は資格情報を勝手に足してしまうので使えません。
 */
const test = base.extend<{ oidc: OidcStack }>({
    oidc: async ({ stack }, use) => {
        const { oidc, shutdown } = await bootOidc(test.info().workerIndex, stack.root);
        await use(oidc);
        await shutdown();
    },
});

/** LAN の外から来たことにする住所 */
const OUTSIDE = '203.0.113.9';
/** 素通しにしてある網の中 */
const INSIDE = '10.10.5.9';

/** Cookie を持って回る、素の fetch */
function client(oidc: OidcStack, { xff = OUTSIDE, host = 'denpa.test' } = {}) {
    const jar = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
        const headers: Record<string, string> = {
            accept: 'text/html',
            /*
             * **名前は `x-forwarded-host` で渡す。** Node の fetch は `Host` を
             * 禁止ヘッダとして黙って落とすので、そちらでは差し替えられない
             * (アプリ側は `HOST_HEADER` でここを見るようにしてある)
             */
            'x-forwarded-host': host,
            'x-forwarded-proto': 'https',
            'x-forwarded-for': xff,
            ...((init.headers as Record<string, string>) ?? {}),
        };
        if (jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        const res = await fetch(`${oidc.appUrl}${path}`, { ...init, headers, redirect: 'manual' });
        for (const raw of res.headers.getSetCookie?.() ?? []) {
            const [pair] = raw.split(';');
            const at = pair.indexOf('=');
            const name = pair.slice(0, at).trim();
            const value = pair.slice(at + 1).trim();
            if (value === '' || /Max-Age=0/i.test(raw)) jar.delete(name);
            else jar.set(name, value);
        }
        return { res, jar };
    };
}

/** 認可の口まで行って、戻ってきた callback を叩く */
async function login(get: ReturnType<typeof client>) {
    const started = await get('/login');
    const authorize = started.res.headers.get('location') ?? '';
    const back = (await fetch(authorize, { redirect: 'manual' })).headers.get('location') ?? '';
    const url = new URL(back);
    return get(url.pathname + url.search);
}

test.describe('OIDC でのログイン', () => {
    test('ログインしていないと、画面はログインへ送られる', async ({ oidc }) => {
        const get = client(oidc);
        const { res } = await get('/');
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/login?to=%2F');
    });

    /*
     * 画面の読み込み以外を 302 で送ると、返ってきた HTML を JSON として読もうとして
     * 意味の分からない失敗になる。401 なら画面側は「切れた」と分かる
     */
    test('画面の読み込み以外は 401 にする', async ({ oidc }) => {
        const get = client(oidc);
        const { res } = await get('/', { headers: { accept: 'application/json' } });
        expect(res.status).toBe(401);
    });

    test('認可の口へは PKCE と state / nonce を付けて送る', async ({ oidc }) => {
        const get = client(oidc);
        const { res, jar } = await get('/login');
        const url = new URL(res.headers.get('location') ?? '');
        expect(url.origin).toBe(oidc.idpUrl);
        expect(url.searchParams.get('client_id')).toBe(oidc.clientId);
        expect(url.searchParams.get('redirect_uri')).toBe('https://denpa.test/login/callback');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('state')).toBeTruthy();
        expect(url.searchParams.get('nonce')).toBeTruthy();
        // 途中の控えは Cookie に預ける
        expect(jar.has('denpa_login')).toBe(true);
    });

    /*
     * **戻り先は自分のところだけ。** そのまま使うと `?to=//evil.example` で
     * 外へ飛ばす踏み台になる (`//` は「同じ scheme の別ホスト」を指す)
     */
    test('外へ飛ばす戻り先は受け付けない', async ({ oidc }) => {
        const get = client(oidc);
        const { jar } = await get('/login?to=%2F%2Fevil.example');
        const pending = JSON.parse(decodeURIComponent(jar.get('denpa_login') ?? '{}'));
        expect(pending.to).toBe('/');
    });

    test('通って戻ると、もとの行き先へ帰る', async ({ oidc }) => {
        const get = client(oidc);
        // 先に行き先を覚えさせてから通す
        const started = await get('/login?to=%2Fsettings');
        const authorize = started.res.headers.get('location') ?? '';
        const back = new URL((await fetch(authorize, { redirect: 'manual' })).headers.get('location') ?? '');
        const { res, jar } = await get(back.pathname + back.search);

        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/settings');
        expect(jar.has('denpa_session')).toBe(true);
        // 使い捨て。成否によらず捨てる
        expect(jar.has('denpa_login')).toBe(false);

        // これで画面が開く
        expect((await get('/')).res.status).toBe(200);
    });

    /*
     * **`state` が「自分が始めたログイン」の証拠。** 合言葉は Cookie にしか無いので、
     * 他所のサイトから貼られたリンクでは通らない
     */
    test('state が合わなければ断る', async ({ oidc }) => {
        const get = client(oidc);
        await get('/login');
        const { res, jar } = await get('/login/callback?code=code-1&state=ちがう');
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('state');
        expect(jar.has('denpa_session')).toBe(false);
    });

    test('途中の控えが無ければ断る', async ({ oidc }) => {
        // Cookie を持たずにいきなり callback を叩く
        const get = client(oidc);
        const { res } = await get('/login/callback?code=code-1&state=x');
        expect(res.status).toBe(403);
    });

    test('ログアウトすると控えが消え、また求められる', async ({ oidc }) => {
        const get = client(oidc);
        await login(get);
        expect((await get('/')).res.status).toBe(200);

        const { res, jar } = await get('/logout', { method: 'POST' });
        expect(res.status).toBe(303);
        expect(res.headers.get('location')).toBe('/login/out');
        expect(jar.has('denpa_session')).toBe(false);
        expect((await get('/')).res.status).toBe(302);
    });
});

/**
 * **通すかどうかはグループで決める。** 誰がログインしたかでは決めない。
 * 断るときは理由を出す — 黙って弾くと「なぜか自分だけ入れない」になる。
 */
test.describe('グループで絞る', () => {
    const setGroups = (oidc: OidcStack, body: { groups?: string[]; omit?: boolean }) =>
        fetch(`${oidc.idpUrl}/__control/groups`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });

    test('入っていなければ断り、理由を出す', async ({ oidc }) => {
        await setGroups(oidc, { groups: ['others'] });
        const { res, jar } = await login(client(oidc));
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('のグループに入っていません');
        expect(jar.has('denpa_session')).toBe(false);
    });

    /*
     * アプリ登録で `groupMembershipClaims` を有効にしていないとこうなる。
     * 「入っていない」と同じ扱いにすると、設定漏れなのか本当に居ないのか分からない
     */
    test('groups がそもそも載っていなければ、そう分かる理由を出す', async ({ oidc }) => {
        await setGroups(oidc, { omit: true });
        const { res } = await login(client(oidc));
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('groupMembershipClaims');
    });
});

/**
 * **網の中なら素通しにする。**
 *
 * LAN のプレイヤー (VLC / Kodi / Infuse) に資格情報を入れずに使わせるためのもの。
 * ここに当たるとベーシック認証も OIDC も掛からない。
 */
test.describe('網で素通し', () => {
    test('網の中なら、何も聞かずに通す', async ({ oidc }) => {
        const get = client(oidc, { xff: INSIDE });
        expect((await get('/')).res.status).toBe(200);
        // ファイルの口も。ここが素通しになるのが狙い
        expect((await get('/dav/', { method: 'PROPFIND' })).res.status).toBe(207);
    });

    test('網の外は通さない', async ({ oidc }) => {
        const get = client(oidc, { xff: OUTSIDE });
        expect((await get('/')).res.status).toBe(302);
        expect((await get('/dav/', { method: 'PROPFIND' })).res.status).toBe(401);
    });

    test('どの名前で来たかは問わない', async ({ oidc }) => {
        // 名前で分けるのは前段 (Traefik) の仕事。ここでは住所だけ見る
        const get = client(oidc, { host: 'lan.denpa.test', xff: INSIDE });
        expect((await get('/')).res.status).toBe(200);
    });

    test('生死確認はどこからでも通る', async ({ oidc }) => {
        // ここを守ると Kubernetes の livenessProbe が落ち、Pod が再起動を繰り返す
        const get = client(oidc, { xff: OUTSIDE });
        const { res } = await get('/api/health', { headers: { accept: 'application/json' } });
        expect(res.status).toBe(200);
    });
});
