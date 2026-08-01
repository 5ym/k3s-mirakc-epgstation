import { fail } from '@sveltejs/kit';
import { database, queryAll, queryOne } from '$lib/server/db';
import { sync } from '$lib/server/epg';
import { enabled as jellyfinEnabled } from '$lib/server/jellyfin';
import { ping } from '$lib/server/mirakurun';
import { cancel } from '$lib/server/reservations';
import { resolveConflicts } from '$lib/server/scheduler';
import type { Recording, Reservation } from '$lib/types';

interface ReservationRow extends Reservation {
    service_name: string;
    rule_name: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * ダッシュボードは予約一覧を兼ねる。
 * 「これから何が録れるか」と「いま何が起きているか」は同じ画面で見たいものなので、
 * 予約を別画面に切り出すと行き来するだけになる。
 */
export async function load({ url }) {
    const at = Date.now();
    const showFinished = url.searchParams.get('all') === '1';

    const recording = queryAll<Recording>(
        `SELECT * FROM recordings WHERE state = 'recording' ORDER BY start_at`,
    );

    const states = showFinished
        ? "('scheduled','conflict','recording','done','failed','canceled','missed')"
        : "('scheduled','conflict','recording')";
    const reservations = queryAll<ReservationRow>(
        `SELECT r.*, s.name AS service_name, rules.name AS rule_name
         FROM reservations r
         JOIN services s ON s.id = r.service_id
         LEFT JOIN rules ON rules.id = r.rule_id
         WHERE r.state IN ${states}
         ORDER BY r.start_at ${showFinished ? 'DESC' : 'ASC'} LIMIT 300`,
    );

    const stats = queryOne<Record<string, number>>(
        `SELECT
            (SELECT COUNT(*) FROM recordings WHERE state = 'available' AND deleted_at IS NULL) AS available,
            (SELECT COALESCE(SUM(ts_size), 0) FROM recordings WHERE deleted_at IS NULL) AS bytes,
            (SELECT COUNT(*) FROM reservations WHERE state = 'scheduled' AND start_at BETWEEN ? AND ?) AS today,
            (SELECT COUNT(*) FROM reservations WHERE state = 'conflict' AND end_at > ?) AS conflicts,
            (SELECT COUNT(*) FROM programs) AS programs,
            (SELECT COUNT(*) FROM services) AS services,
            (SELECT COUNT(*) FROM encode_jobs WHERE state IN ('queued','running')) AS encoding`,
        at,
        at + DAY,
        at,
    )!;

    // 失敗は放っておくと気づけないので目立つところに出す。
    // 時間で勝手に消すと見逃すので、確認するまで残して消せるようにしてある
    const failures = queryAll<{ id: number; name: string; error: string | null; updated_at: number }>(
        `SELECT id, name, error, updated_at FROM recordings
         WHERE state = 'failed' AND deleted_at IS NULL AND acknowledged_at IS NULL
         ORDER BY updated_at DESC LIMIT 10`,
    );

    return {
        recording,
        reservations,
        showFinished,
        stats,
        failures,
        mirakurun: await ping(),
        jellyfin: jellyfinEnabled(),
    };
}

export const actions = {
    sync: async () => {
        return { success: true, sync: await sync() };
    },

    cancel: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: '予約IDが不正です' });
        await cancel(id);
        return { success: true };
    },

    acknowledge: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        const sql =
            Number.isFinite(id) && id > 0
                ? `UPDATE recordings SET acknowledged_at = ? WHERE id = ${id}`
                : `UPDATE recordings SET acknowledged_at = ? WHERE state = 'failed' AND acknowledged_at IS NULL`;
        database().prepare(sql).run(Date.now());
        return { success: true };
    },

    resolve: async () => {
        await resolveConflicts();
        return { success: true };
    },
};
