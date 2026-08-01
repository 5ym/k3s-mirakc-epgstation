import { fail } from '@sveltejs/kit';
import { database } from '$lib/server/db';
import { importTimers, enabled as jellyfinEnabled } from '$lib/server/jellyfin';
import { cancel } from '$lib/server/reservations';
import { resolveConflicts } from '$lib/server/scheduler';
import type { Reservation } from '$lib/types';

interface Row extends Reservation {
    service_name: string;
    rule_name: string | null;
}

export function load({ url }) {
    const showFinished = url.searchParams.get('all') === '1';
    const states = showFinished
        ? "('scheduled','conflict','recording','done','failed','canceled')"
        : "('scheduled','conflict','recording')";

    const reservations = database()
        .prepare(
            `SELECT r.*, s.name AS service_name, rules.name AS rule_name
             FROM reservations r
             JOIN services s ON s.id = r.service_id
             LEFT JOIN rules ON rules.id = r.rule_id
             WHERE r.state IN ${states}
             ORDER BY r.start_at DESC LIMIT 300`,
        )
        .all() as Row[];

    return { reservations, showFinished, jellyfin: jellyfinEnabled() };
}

export const actions = {
    cancel: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: '予約IDが不正です' });
        await cancel(id);
        return { success: true };
    },
    resolve: async () => {
        await resolveConflicts();
        return { success: true };
    },

    importTimers: async () => {
        // 定期取り込み(JELLYFIN_TIMER_INTERVAL)を待たずに反映したいとき用
        try {
            return { success: true, timers: await importTimers() };
        } catch (error) {
            return fail(502, { message: `Jellyfin から取り込めませんでした: ${error}` });
        }
    },
};
