import { start } from '$lib/server/runtime';

// SvelteKit のサーバ起動時に一度だけ走る。EPG取得・スケジューラ・エンコーダを立ち上げる
start();

export async function handle({ event, resolve }) {
    return resolve(event);
}
