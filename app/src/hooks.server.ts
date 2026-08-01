import { authorized, challenge, protects } from '$lib/server/auth';
import { handleDav } from '$lib/server/dav';
import { start } from '$lib/server/runtime';

// SvelteKit のサーバ起動時に一度だけ走る。EPG取得・スケジューラ・エンコーダを立ち上げる
start();

export async function handle({ event, resolve }) {
    if (protects(event.url.pathname) && !authorized(event.request.headers.get('authorization'))) {
        return challenge();
    }

    // WebDAV の PROPFIND は SvelteKit のルートでは受けられないのでここで捌く
    const dav = handleDav(event.request, event.url);
    if (dav !== null) return dav;

    return resolve(event);
}
