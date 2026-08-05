import { redirect } from '@sveltejs/kit';
import { COOKIE, destroy } from '$lib/server/session';

/**
 * ログアウト。**こちらの控えを消すだけ**で、Entra 側からは出さない。
 *
 * `end_session_endpoint` へ送ると、同じ Entra で入っている他のものまで
 * 巻き添えで切れる。「denpa から出たい」と「Microsoft から出たい」は別の話。
 *
 * 出たあとに `/` へ戻すと、SSO が効いている間は黙って入り直してしまい、
 * 出られたのかどうか画面から分からない。行き先は知らせの画面にする。
 */
function out(cookies: import('@sveltejs/kit').Cookies): never {
    destroy(cookies.get(COOKIE));
    cookies.delete(COOKIE, { path: '/' });
    redirect(303, '/login/out');
}

export function GET({ cookies }) {
    out(cookies);
}
export function POST({ cookies }) {
    out(cookies);
}
