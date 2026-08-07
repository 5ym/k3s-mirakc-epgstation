import { fail } from '@sveltejs/kit';
import { queryAll, queryOne } from '$lib/server/db';
import { airing, CURRENT_SERVICES, SERVICE_ORDER } from '$lib/server/epg';
import { playContext } from '$lib/server/play';
import { cancel, reserve } from '$lib/server/reservations';
import { RESERVATION_STATE } from '$lib/server/schema';
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
    /**
     * その番組で録れたもの。番組表から詳細を開いたときに、そのまま再生できるようにする。
     * 録画一覧まで戻って同じ番組を探し直させないため
     */
    recording_id: number | null;
    recording_name: string | null;
    /** 配信は library_path ?? ts_path を返すので、どちらかがあれば開ける */
    library_path: string | null;
    ts_path: string | null;
}

/**
 * 番組表は2つの見せ方をする。
 * キーワードなし: 時間×チャンネルのグリッド。並びを眺めて選ぶとき用
 * キーワードあり: 全チャンネル横断のリスト。探しているものが決まっているとき用
 */
export async function load({ url, request }) {
    const type = (TYPES.find((t) => t === url.searchParams.get('type')) ?? 'GR') as ChannelType;

    // 既定は今日の放送日。めくるときだけ start が付く
    const requested = Number(url.searchParams.get('start'));
    const start = broadcastDayStart(Number.isFinite(requested) && requested > 0 ? requested : Date.now());
    const end = start + WINDOW_HOURS * HOUR;

    // テレビと同じ並びにする (SERVICE_ORDER)。
    // 取り残しの局は出さない (CURRENT_SERVICES)。出すと番組表に空の列が並ぶ
    const services = queryAll<Service>(
        `SELECT * FROM services WHERE type = ? AND ${CURRENT_SERVICES}
         ORDER BY ${SERVICE_ORDER}`,
        type,
    );
    const programs = queryAll<GridProgram>(
        /*
         * 予約の状態は録画の行から引く (RESERVATION_STATE)。r.state をそのまま
         * 出していた頃は、録り終えた番組が「予約済み」のまま並び、
         * 取消ボタンまで出ていた (予約側は録り始めた時刻しか持たないため)
         */
        `SELECT p.*,
                CASE WHEN r.id IS NULL THEN NULL ELSE ${RESERVATION_STATE} END AS reservation_state,
                rec.id AS recording_id, rec.name AS recording_name,
                rec.library_path, rec.ts_path
         FROM programs p
         JOIN services s ON s.id = p.service_id
         LEFT JOIN reservations r ON r.program_id = p.id AND r.state != 'canceled'
         -- 録り直すと同じ番組に複数ぶら下がる。いちばん新しい現存分だけ見る
         LEFT JOIN recordings rec ON rec.id = (
             SELECT id FROM recordings
             WHERE program_id = p.id AND deleted_at IS NULL
             ORDER BY id DESC LIMIT 1
         )
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
        // 放送していない局は出さない (終わったチャンネル・相乗り中のサブチャンネル)
        services: airing(services, programs),
        counts: queryOne<{ programs: number; services: number }>(
            'SELECT (SELECT COUNT(*) FROM programs) AS programs, (SELECT COUNT(*) FROM services) AS services',
        )!,
        // 録れた番組は詳細からそのまま再生できる。宛先の決め方は録画一覧と同じ (server/play.ts)
        ...playContext(request, url),
    };
}

export const actions = {
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

    /**
     * 番組表から予約する。
     *
     * 録画のしかた(エンコードするか・生TSを残すか)はここでは選ばせない。
     * 設定画面の1箇所で決める (docs/app.md)。番組ごとに変えたくなることが
     * 実際にはほとんど無いのに、同じ選択肢が予約・ルール・設定の3箇所にあると
     * 「どれで決まったのか」が分からなくなる
     */
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
