import { json } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';

/** compose の healthcheck と E2E の起動待ちに使う。DBまで触って初めて ok を返す */
export function GET() {
    const row = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM services');
    return json({ ok: true, services: row?.n ?? 0 });
}
