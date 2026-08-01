import { fail } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { database, queryOne } from '$lib/server/db';
import { sync } from '$lib/server/epg';
import { enabled as jellyfinEnabled, registerLiveTv } from '$lib/server/jellyfin';
import { sessions, stopSession } from '$lib/server/live';
import { ping } from '$lib/server/mirakurun';
import type { EncodeJob, Recording, Reservation } from '$lib/types';

interface JobRow extends EncodeJob {
    recording_name: string;
}

export async function load() {
    const recording = database()
        .prepare(`SELECT * FROM recordings WHERE state = 'recording' ORDER BY start_at`)
        .all() as Recording[];

    const upcoming = database()
        .prepare(
            `SELECT * FROM reservations WHERE state IN ('scheduled','conflict') AND end_at > ?
             ORDER BY start_at LIMIT 10`,
        )
        .all(Date.now()) as Reservation[];

    const encoding = database()
        .prepare(
            `SELECT j.*, r.name AS recording_name FROM encode_jobs j
             JOIN recordings r ON r.id = j.recording_id
             WHERE j.state IN ('queued','running') ORDER BY j.id LIMIT 10`,
        )
        .all() as JobRow[];

    const stats = queryOne<Record<string, number>>(
        `SELECT
                (SELECT COUNT(*) FROM recordings WHERE state = 'available' AND deleted_at IS NULL) AS available,
                (SELECT COUNT(*) FROM recordings WHERE deleted_at IS NOT NULL) AS deleted,
                (SELECT COUNT(*) FROM programs) AS programs,
                (SELECT COUNT(*) FROM services) AS services,
            (SELECT COUNT(*) FROM reservations WHERE state = 'conflict') AS conflicts`,
    )!;

    return {
        recording,
        upcoming,
        encoding,
        stats,
        mirakurun: await ping(),
        live: sessions(),
        jellyfin: jellyfinEnabled(),
    };
}

export const actions = {
    sync: async () => {
        return { success: true, sync: await sync() };
    },

    registerLiveTv: async ({ url }) => {
        // Jellyfin から見た denpa のURL。設定が無ければこのリクエストのオリジンを使う
        const origin = config.iptvOrigin === '' ? url.origin : config.iptvOrigin;
        try {
            return { success: true, register: await registerLiveTv(origin, config.liveProfile) };
        } catch (error) {
            return fail(502, { message: `Jellyfin への登録に失敗しました: ${error}` });
        }
    },

    stopLive: async ({ request }) => {
        const form = await request.formData();
        stopSession(Number(form.get('id')));
        return { success: true };
    },
};
