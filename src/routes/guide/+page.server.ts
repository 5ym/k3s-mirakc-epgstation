import { fail } from '@sveltejs/kit';
import { queryAll, queryOne } from '$lib/server/db';
import { sync } from '$lib/server/epg';
import { ping } from '$lib/server/mirakurun';
import { cancel, reserve } from '$lib/server/reservations';
import { status as scanStatus, start as startScan } from '$lib/server/scan';
import { settings } from '$lib/server/settings';
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
export async function load({ url }) {
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

    return {
        type,
        start,
        hours: WINDOW_HOURS,
        programs,
        services,
        // 予約の詳細で初期値として出す
        defaults: settings(),
        /*
         * Mirakurun への疎通確認。await せずに promise のまま返して後から流し込む。
         * 待ってから返すと、Mirakurun の応答が遅いぶん番組表そのものが出るのが遅れる。
         * 番組表は手元のDBだけで描けるので、状態表示のために止める必要はない
         */
        mirakurun: ping(),
        scan: scanStatus(),
        counts: queryOne<{ programs: number; services: number }>(
            'SELECT (SELECT COUNT(*) FROM programs) AS programs, (SELECT COUNT(*) FROM services) AS services',
        )!,
    };
}

export const actions = {
    /** 番組表が古いときに取り直す。番組表の追従と新規予約もここで走る */
    sync: async () => {
        return { success: true, sync: await sync() };
    },

    /**
     * チャンネルスキャン。走らせるのは Mirakurun で、結果も Mirakurun が
     * 自分の channels.yml に書き戻す。数分かかるので開始だけ受ける
     */
    scan: async ({ request }) => {
        const form = await request.formData();
        const type = TYPES.find((t) => t === form.get('type'));
        if (type === undefined) return fail(400, { message: 'チャンネル種別が不正です' });

        const range = (name: string) => {
            const value = Number(form.get(name));
            return Number.isFinite(value) && value > 0 ? value : undefined;
        };
        const result = startScan({ type, min: range('min'), max: range('max') });
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },

    /** 番組表から予約を止める。予約一覧まで行かずに済むように */
    cancel: async ({ request }) => {
        const form = await request.formData();
        const programId = Number(form.get('programId'));
        if (!Number.isFinite(programId)) return fail(400, { message: '番組IDが不正です' });
        const reservation = queryOne<{ id: number }>(
            `SELECT id FROM reservations WHERE program_id = ? AND state != 'canceled'`,
            programId,
        );
        if (reservation === undefined) return fail(404, { message: '予約が見つかりません' });
        await cancel(reservation.id);
        return { success: true };
    },

    reserve: async ({ request }) => {
        const form = await request.formData();
        const programId = Number(form.get('programId'));
        if (!Number.isFinite(programId)) return fail(400, { message: '番組IDが不正です' });

        // 詳細の画面からはこの番組だけの録画のしかたを決められる。
        // チェックを外した状態はキーごと消えるので、画面から来たことを印で見分ける。
        // 印が無い(APIから番組IDだけ投げた)ときは既定のまま
        const fromForm = form.get('options') === '1';
        try {
            await reserve(programId, {
                encode: fromForm ? form.get('encode') === 'on' : undefined,
                keepOriginal: fromForm && form.get('keepOriginal') === 'on',
            });
        } catch (error) {
            return fail(400, { message: String(error) });
        }
        return { success: true };
    },
};
