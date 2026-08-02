import { json } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { activeRecordingIds } from '$lib/server/recorder';

/**
 * compose の healthcheck と E2E の起動待ちに使う。DBまで触って初めて ok を返す。
 *
 * 録画の本数も返す。入れ替えていいかどうかを外から見たいことがあるため
 * (待つこと自体はアプリ側でやっている。runtime.ts の drain)。
 */
export function GET() {
    const row = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM services');
    return json({ ok: true, services: row?.n ?? 0, recording: activeRecordingIds().length });
}
