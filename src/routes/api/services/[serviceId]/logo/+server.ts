import { error } from '@sveltejs/kit';
import { fetchLogo } from '$lib/server/mirakc';

/**
 * 局ロゴの中継。
 *
 * mirakc を直接ブラウザから叩かせると、denpa と mirakc の両方を
 * 外に出す必要が出てくるので、こちら経由で渡す。
 * ロゴは滅多に変わらないので長めにキャッシュさせる。
 */
export async function GET({ params, setHeaders }) {
    const serviceId = Number(params.serviceId);
    if (!Number.isFinite(serviceId)) error(400, 'チャンネルIDが不正です');

    const logo = await fetchLogo(serviceId);
    if (logo === null) error(404, 'ロゴがありません');

    setHeaders({
        'Content-Type': logo.headers.get('content-type') ?? 'image/png',
        'Cache-Control': 'public, max-age=86400',
    });
    return new Response(logo.body);
}
