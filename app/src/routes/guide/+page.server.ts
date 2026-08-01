import { fail } from '@sveltejs/kit';
import { queryAll } from '$lib/server/db';
import { reserve } from '$lib/server/reservations';
import type { ChannelType, Program, Service } from '$lib/types';

const HOUR = 60 * 60 * 1000;
/** 一度に出す時間幅。長くすると縦に伸びるだけなので、めくって見る前提にする */
const WINDOW_HOURS = 6;
const TYPES: ChannelType[] = ['GR', 'BS', 'CS'];

interface GridProgram extends Program {
    reservation_state: string | null;
}

interface ListProgram extends GridProgram {
    service_name: string;
}

/**
 * 番組表は2つの見せ方をする。
 * キーワードなし: 時間×チャンネルのグリッド。並びを眺めて選ぶとき用
 * キーワードあり: 全チャンネル横断のリスト。探しているものが決まっているとき用
 */
export function load({ url }) {
    const keyword = (url.searchParams.get('q') ?? '').trim();
    const type = (TYPES.find((t) => t === url.searchParams.get('type')) ?? 'GR') as ChannelType;

    const requested = Number(url.searchParams.get('start'));
    // 既定は「いまの時間の頭から」。めくるときだけ start が付く
    const start =
        Number.isFinite(requested) && requested > 0
            ? Math.floor(requested / HOUR) * HOUR
            : Math.floor(Date.now() / HOUR) * HOUR;
    const end = start + WINDOW_HOURS * HOUR;

    if (keyword !== '') {
        const programs = queryAll<ListProgram>(
            `SELECT p.*, s.name AS service_name, r.state AS reservation_state
             FROM programs p
             JOIN services s ON s.id = p.service_id
             LEFT JOIN reservations r ON r.program_id = p.id AND r.state != 'canceled'
             WHERE p.end_at > ? AND (p.name LIKE ? OR p.description LIKE ?)
             ORDER BY p.start_at LIMIT 300`,
            Date.now(),
            `%${keyword}%`,
            `%${keyword}%`,
        );
        return { mode: 'list' as const, keyword, type, start, hours: WINDOW_HOURS, programs, services: [] };
    }

    const services = queryAll<Service>('SELECT * FROM services WHERE type = ? ORDER BY channel', type);
    const programs = queryAll<GridProgram>(
        `SELECT p.*, r.state AS reservation_state
         FROM programs p
         JOIN services s ON s.id = p.service_id
         LEFT JOIN reservations r ON r.program_id = p.id AND r.state != 'canceled'
         WHERE s.type = ? AND p.start_at < ? AND p.end_at > ?
         ORDER BY p.start_at`,
        type,
        end,
        start,
    );

    return { mode: 'grid' as const, keyword, type, start, hours: WINDOW_HOURS, programs, services };
}

export const actions = {
    reserve: async ({ request }) => {
        const form = await request.formData();
        const programId = Number(form.get('programId'));
        if (!Number.isFinite(programId)) return fail(400, { message: '番組IDが不正です' });
        try {
            await reserve(programId);
        } catch (error) {
            return fail(400, { message: String(error) });
        }
        return { success: true };
    },
};
