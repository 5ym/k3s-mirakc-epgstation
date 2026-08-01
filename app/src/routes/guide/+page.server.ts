import { fail } from '@sveltejs/kit';
import { queryAll } from '$lib/server/db';
import { reserve } from '$lib/server/reservations';
import type { ChannelType, Program, Service } from '$lib/types';

const HOUR = 60 * 60 * 1000;
/**
 * 日本の番組表の慣習に合わせ、1日は 4:00 から翌 4:00 まで。
 * 深夜番組が翌日側に送られると探しにくいため。
 */
const DAY_START_HOUR = 4;
const WINDOW_HOURS = 24;
const TYPES: ChannelType[] = ['GR', 'BS', 'CS'];

/** その時刻が属する放送日の 4:00 (ローカル時刻) */
function broadcastDayStart(at: number): number {
    const d = new Date(at);
    if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
    d.setHours(DAY_START_HOUR, 0, 0, 0);
    return d.getTime();
}

interface GridProgram extends Program {
    reservation_state: string | null;
}

/**
 * 番組表は2つの見せ方をする。
 * キーワードなし: 時間×チャンネルのグリッド。並びを眺めて選ぶとき用
 * キーワードあり: 全チャンネル横断のリスト。探しているものが決まっているとき用
 */
export function load({ url }) {
    const type = (TYPES.find((t) => t === url.searchParams.get('type')) ?? 'GR') as ChannelType;

    // 既定は今日の放送日。めくるときだけ start が付く
    const requested = Number(url.searchParams.get('start'));
    const start = broadcastDayStart(Number.isFinite(requested) && requested > 0 ? requested : Date.now());
    const end = start + WINDOW_HOURS * HOUR;

    // テレビと同じ並びにする。リモコン番号を持つのは地上波だけなので、
    // 持たない局は物理チャンネル順で後ろに続ける
    const services = queryAll<Service>(
        `SELECT * FROM services WHERE type = ?
         ORDER BY remote_control_key IS NULL, remote_control_key, channel, service_id`,
        type,
    );
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

    return { type, start, hours: WINDOW_HOURS, programs, services };
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
