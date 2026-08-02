import { error } from '@sveltejs/kit';
import { readLogo } from '$lib/server/logo';

/**
 * 局ロゴ。denpa が放送波から拾ったものを配る (src/lib/server/logo.ts)。
 * 滅多に変わらないので長めにキャッシュさせる。
 */
export function GET({ params, setHeaders }) {
    const serviceId = Number(params.serviceId);
    if (!Number.isFinite(serviceId)) error(400, 'チャンネルIDが不正です');

    const logo = readLogo(serviceId);
    if (logo === null) error(404, 'ロゴがありません');

    setHeaders({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return new Response(logo as BodyInit);
}
