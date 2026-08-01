import { fail, redirect } from '@sveltejs/kit';
import { isCmMode } from '$lib/server/cm';
import { config } from '$lib/server/config';
import { database, now, queryAll } from '$lib/server/db';
import { isVideoCodec } from '$lib/server/encoder';
import { reserve } from '$lib/server/reservations';
import { applyRules, matches } from '$lib/server/rules';
import { resolveConflicts } from '$lib/server/scheduler';
import type { ChannelType, Program, Rule, Service } from '$lib/types';

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

interface ListProgram extends GridProgram {
    service_name: string;
    service_type: string;
}

/**
 * 検索条件から、保存していないルールを組み立てる。
 *
 * 番組表の検索とルールの条件を同じものにしておくための要。
 * 別々に書くと「検索で出たもの」と「ルールで録れるもの」がずれる(実際ずれていた)。
 */
function conditionsFrom(params: URLSearchParams | FormData): Rule | null {
    const get = (key: string) => String(params.get(key) ?? '').trim();
    // チェックボックスは types=GR&types=BS、隠しフィールドは types=GR,BS で来る
    const list = (key: string) =>
        params
            .getAll(key)
            .flatMap((value) => String(value).split(','))
            .map((value) => value.trim())
            .filter(Boolean);

    const keyword = get('q');
    const services = list('services').map(Number).filter(Number.isFinite);
    const types = list('types');
    if (keyword === '' && services.length === 0 && types.length === 0) return null;

    return {
        id: 0,
        name: '',
        keyword,
        ignore_keyword: get('exclude'),
        service_ids: services.length === 0 ? null : JSON.stringify(services),
        service_types: types.length === 0 ? null : JSON.stringify(types),
        genres: null,
        free_only: get('free') === '1' ? 1 : 0,
        enabled: 1,
        priority: 2,
        encode: 1,
        keep_original: 0,
        cm_cut: config.cmCutDefault,
        codec: config.encodeCodec,
        created_at: 0,
    };
}

/**
 * 番組表は2つの見せ方をする。
 * キーワードなし: 時間×チャンネルのグリッド。並びを眺めて選ぶとき用
 * キーワードあり: 全チャンネル横断のリスト。探しているものが決まっているとき用
 */
export function load({ url }) {
    const keyword = (url.searchParams.get('q') ?? '').trim();
    const type = (TYPES.find((t) => t === url.searchParams.get('type')) ?? 'GR') as ChannelType;

    // 既定は今日の放送日。めくるときだけ start が付く
    const requested = Number(url.searchParams.get('start'));
    const start = broadcastDayStart(Number.isFinite(requested) && requested > 0 ? requested : Date.now());
    const end = start + WINDOW_HOURS * HOUR;

    const conditions = conditionsFrom(url.searchParams);
    if (conditions !== null) {
        // ルールと同じ判定を通す。ここが違うと「検索で出た番組がルールでは録れない」が起きる
        const all = queryAll<ListProgram>(
            `SELECT p.*, s.name AS service_name, s.type AS service_type, r.state AS reservation_state
             FROM programs p
             JOIN services s ON s.id = p.service_id
             LEFT JOIN reservations r ON r.program_id = p.id AND r.state != 'canceled'
             WHERE p.end_at > ? ORDER BY p.start_at`,
            Date.now(),
        );
        const hits = all.filter((p) => matches(conditions, p, p.service_type));
        return {
            mode: 'list' as const,
            keyword,
            type,
            start,
            hours: WINDOW_HOURS,
            total: hits.length,
            programs: hits.slice(0, 300),
            services: queryAll<Service>(
                `SELECT * FROM services
                 ORDER BY type, remote_control_key IS NULL, remote_control_key, channel, service_id`,
            ),
        };
    }

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
        mode: 'grid' as const,
        keyword,
        type,
        start,
        hours: WINDOW_HOURS,
        total: programs.length,
        programs,
        services,
    };
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

    /**
     * いま見ている検索条件をそのままルールにする。
     * 「気に入った検索を保存する」という流れにしておけば、条件を2度入力しなくて済む
     */
    createRule: async ({ request }) => {
        const form = await request.formData();
        const conditions = conditionsFrom(form);
        if (conditions === null) {
            return fail(400, { message: 'キーワードかチャンネルのどちらかは指定してください' });
        }

        const cmCut = form.get('cmCut');
        const codec = form.get('codec');
        const name = conditions.keyword !== '' ? conditions.keyword : '番組表からのルール';
        database()
            .prepare(
                `INSERT INTO rules (name, keyword, ignore_keyword, service_ids, service_types, genres,
                                    free_only, enabled, priority, encode, keep_original, cm_cut, codec, created_at)
                 VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, 1, 0, ?, ?, ?)`,
            )
            .run(
                name,
                conditions.keyword,
                conditions.ignore_keyword,
                conditions.service_ids,
                conditions.service_types,
                conditions.free_only,
                Number(form.get('priority') ?? 2) || 2,
                isCmMode(cmCut) ? cmCut : config.cmCutDefault,
                isVideoCodec(codec) ? codec : config.encodeCodec,
                now(),
            );

        applyRules();
        await resolveConflicts();
        redirect(303, '/rules');
    },
};
