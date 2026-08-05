import { redirect } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { complete, enabled, readPending, redirectUri } from '$lib/server/oidc';
import { COOKIE, create, PENDING_COOKIE } from '$lib/server/session';

function failed(message: string): Response {
    // ここは人が見る画面。何が起きたか読めないと、設定のどこが悪いのか追えない
    return new Response(`ログインできませんでした: ${message}`, {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
}

/**
 * Entra から戻ってくるところ。
 *
 * **`state` が合うことが「自分が始めたログイン」の証拠**になる。合言葉は
 * Cookie にしか無いので、他所のサイトから貼られたリンクでは通らない。
 */
export async function GET({ url, cookies }) {
    if (!enabled()) return new Response('OIDC が設定されていません', { status: 404 });

    const pending = readPending(cookies.get(PENDING_COOKIE));
    // 使い捨て。成否によらずここで捨てる
    cookies.delete(PENDING_COOKIE, { path: '/' });

    const error = url.searchParams.get('error');
    if (error !== null) {
        return failed(`${error} ${url.searchParams.get('error_description') ?? ''}`.trim());
    }
    if (pending === null) return failed('ログインの途中の控えがありません。もう一度お試しください');

    const state = url.searchParams.get('state');
    if (state !== pending.state) return failed('state が合いません');

    const code = url.searchParams.get('code');
    if (code === null) return failed('code がありません');

    let who: { subject: string; name: string };
    try {
        who = await complete(code, redirectUri(url.origin), pending);
    } catch (cause) {
        console.warn(`[auth] ログインを断りました: ${cause}`);
        return failed(String(cause instanceof Error ? cause.message : cause));
    }

    const session = create(who.subject, who.name);
    console.log(`[auth] ログイン: ${who.name || who.subject}`);
    cookies.set(COOKIE, session.id, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: url.protocol === 'https:',
        maxAge: Math.floor(config.oidcSessionTtl / 1000),
    });
    redirect(303, pending.to);
}
