import { redirect } from '@sveltejs/kit';
import { authorized, challenge, needsLogin, protects } from '$lib/server/auth';
import { handleDav } from '$lib/server/dav';
import { start } from '$lib/server/runtime';
import { bypassed, COOKIE, find } from '$lib/server/session';

// SvelteKit のサーバ起動時に一度だけ走る。EPG取得・スケジューラ・エンコーダを立ち上げる
start();

/**
 * 接続元の住所。**読めなければ空文字を返す。**
 *
 * adapter-node は `ADDRESS_HEADER` を渡してあるのにそのヘッダが無いリクエストが
 * 来ると**例外を投げる**。Traefik を通らずに Pod へ直に届くもの (kubelet の
 * ヘルスチェックなど) がそれで、そのまま呼ぶと 500 になる。
 *
 * **読めなかったときは素通しにしない** (空文字はどの CIDR にも当たらない)。
 * 分からないほうを通すと、ヘッダを外すだけで認証を抜けられてしまう
 */
function clientAddress(event: Parameters<typeof handle>[0]['event']): string {
    try {
        return event.getClientAddress();
    } catch {
        return '';
    }
}

export async function handle({ event, resolve }) {
    const { pathname, search } = event.url;

    if (protects(pathname) && !authorized(event.request.headers.get('authorization'))) {
        return challenge();
    }

    /*
     * **OIDC でのログイン。** 設定してあるときだけ効く (`auth.needsLogin`)。
     *
     * ここで見るのは Cookie の控えだけ。Entra とのやり取りは `/login` と
     * `/login/callback` に閉じてあり、普段のリクエストで外へ出ることはない。
     */
    if (needsLogin(pathname)) {
        const session = find(event.cookies.get(COOKIE));
        if (session !== null) {
            event.locals.user = { subject: session.subject, name: session.name };
        } else if (!bypassed(clientAddress(event))) {
            /*
             * **LAN からは今までどおり素通し** (`bypassed`)。住所は adapter-node が
             * `ADDRESS_HEADER` を見て決めるので、渡していないと Traefik の Pod の
             * 住所が来て、ここが誰にも当たらない (=全員ログインを求められる)。
             *
             * **画面の読み込み以外はリダイレクトしない。** fetch やフォーム送信を
             * 302 でログイン画面へ送ると、返ってきた HTML を JSON として読もうとして
             * 意味の分からない失敗になる。401 なら画面側は「切れた」と分かる
             */
            const wantsHtml = event.request.headers.get('accept')?.includes('text/html') === true;
            if (event.request.method !== 'GET' || !wantsHtml) {
                return new Response('login required', { status: 401 });
            }
            redirect(302, `/login?to=${encodeURIComponent(pathname + search)}`);
        }
    }

    // WebDAV の PROPFIND は SvelteKit のルートでは受けられないのでここで捌く
    const dav = handleDav(event.request, event.url);
    if (dav !== null) return dav;

    return resolve(event);
}
