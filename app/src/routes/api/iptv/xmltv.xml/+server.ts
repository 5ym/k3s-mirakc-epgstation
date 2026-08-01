import { queryAll } from '$lib/server/db';
import { xmltv } from '$lib/server/iptv';
import type { Program, Service } from '$lib/types';

/** Jellyfin の「XMLTV」ガイドデータプロバイダーに登録する番組表 */
export function GET() {
    const services = queryAll<Service>('SELECT * FROM services ORDER BY type, channel');
    const programs = queryAll<Program>(
        'SELECT * FROM programs WHERE end_at > ? ORDER BY service_id, start_at',
        Date.now(),
    );

    return new Response(xmltv(services, programs), {
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
