import { error } from '@sveltejs/kit';
import { readLogo } from '$lib/server/logo';

/**
 * 局ロゴ。
 *
 * mirakc はロゴを TS から集めないので、denpa が放送波から拾って持っている
 * (src/lib/server/logo.ts)。ロゴは滅多に変わらないので長めにキャッシュさせる。
 */
export function GET({ params, setHeaders }) {
    const serviceId = Number(params.serviceId);
    if (!Number.isFinite(serviceId)) error(400, 'チャンネルIDが不正です');

    const logo = readLogo(serviceId);
    if (logo === null) error(404, 'ロゴがありません');

    setHeaders({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return new Response(logo as BodyInit);
}
