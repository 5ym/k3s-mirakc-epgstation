import { fail, redirect } from '@sveltejs/kit';
import { genreName } from '$lib/arib';
import { parseSearchFields } from '$lib/search';
import { database, now, queryAll, queryOne } from '$lib/server/db';
import { CURRENT_SERVICES } from '$lib/server/epg';
import { cancel } from '$lib/server/reservations';
import { applyRules, compile, haystack, matchesCompiled } from '$lib/server/rules';
import { resolveConflicts } from '$lib/server/scheduler';
import { settings } from '$lib/server/settings';
import type { Program, Rule, Service } from '$lib/types';

interface Row extends Rule {
    reservations: number;
}

/** これから録るぶん。終わったものも取り消したものも数えない */
const PENDING_STATES = "('scheduled', 'conflict', 'recording')";

/**
 * 入力中の条件を、保存していないルールとして組み立てる。
 *
 * 条件を編集する場所はこの画面1つに寄せてある。番組表にも検索欄を置いていた頃は
 * 判定が二重にあってズレたので、フォームの値がそのまま「何が録れるか」になるようにした。
 */
function conditionsFrom(params: URLSearchParams): Rule | null {
    const get = (key: string) => String(params.get(key) ?? '').trim();
    const numbers = params.getAll('serviceIds').map(Number).filter(Number.isFinite);
    const types = params.getAll('serviceTypes').map(String).filter(Boolean);
    const genres = params.getAll('genres').map(String).filter(Boolean);
    const keyword = get('keyword');
    if (keyword === '' && numbers.length === 0 && types.length === 0 && genres.length === 0) return null;

    return {
        id: 0,
        name: '',
        keyword,
        ignore_keyword: get('ignoreKeyword'),
        // 番組表から来たときは指定が無い。既定 (番組名だけ) になる
        search_fields: parseSearchFields(params.getAll('searchFields').join(',')).join(','),
        service_ids: numbers.length === 0 ? null : JSON.stringify(numbers),
        service_types: types.length === 0 ? null : JSON.stringify(types),
        genres: genres.length === 0 ? null : JSON.stringify(genres),
        // ルール画面のフォームから来たときだけ、チェックが無い=外したと解釈する
        free_only: params.get('form') === 'rules' ? (params.get('freeOnly') === 'on' ? 1 : 0) : 1,
        enabled: 1,
        priority: 2,
        encode: 1,
        keep_original: 0,
        cm_cut: settings().cmCut,
        codec: settings().codec,
        source: null,
        created_at: 0,
    };
}

/** 編集中のルールが押さえている予約。1件ずつ取り消せるように出す */
export interface PendingRow {
    id: number;
    name: string;
    service_name: string;
    start_at: number;
    end_at: number;
    state: string;
}

export interface PreviewRow {
    id: number;
    name: string;
    description: string;
    service_name: string;
    start_at: number;
    end_at: number;
    reservation_state: string | null;
}

export function load({ url }) {
    const defaults = settings();
    // ?edit=<id> のときは、そのルールをフォームに読み込んで書き換えられるようにする
    const editing = queryOne<Rule>('SELECT * FROM rules WHERE id = ?', Number(url.searchParams.get('edit')));

    /*
     * 条件が入っていれば、その条件で録れる番組を出す。
     *
     * URL に載っている条件を優先する。編集中に「この条件で何が録れるか見る」を押すと
     * ?edit=<id> と書き換えたフォームの値が一緒に飛んでくるので、保存済みのほうを
     * 使うと**いま画面に入っている条件ではない結果**が出てしまう。
     */
    const conditions = conditionsFrom(url.searchParams) ?? editing ?? null;
    let preview: { total: number; programs: PreviewRow[] } | null = null;
    if (conditions !== null && url.searchParams.size > 0) {
        const all = queryAll<
            Program & { service_type: string; service_name: string; reservation_state: string | null }
        >(
            `SELECT p.*, s.type AS service_type, s.name AS service_name, r.state AS reservation_state
             FROM programs p
             JOIN services s ON s.id = p.service_id
             LEFT JOIN reservations r ON r.program_id = p.id AND r.state != 'canceled'
             WHERE p.start_at > ? ORDER BY p.start_at`,
            now(),
        );
        // 条件のほどきは1回だけ。番組ごとにやり直すと、番組の数だけ JSON を読むことになる
        const compiled = compile(conditions);
        const hits = all.filter((program) =>
            matchesCompiled(compiled, program, program.service_type, defaults.freeOnly, (fields) =>
                haystack(program, fields),
            ),
        );
        preview = {
            total: hits.length,
            programs: hits.slice(0, 100).map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                service_name: p.service_name,
                start_at: p.start_at,
                end_at: p.end_at,
                reservation_state: p.reservation_state,
            })),
        };
    }
    /*
     * 予約数は**これから録るぶんだけ**。
     *
     * 全部の行を数えていた頃は、録り終えたものも取り消したものも混ざるので、
     * ルールを止めても数が減らず、編集画面に出る件数とも合わなかった。
     * この列を見るのは「このルールがいま何を押さえているか」を知りたいときなので、
     * 履歴は数えない
     */
    const rules = database()
        .prepare(
            `SELECT r.*, (
                 SELECT COUNT(*) FROM reservations
                 WHERE rule_id = r.id AND state IN ${PENDING_STATES}
             ) AS reservations
             FROM rules r ORDER BY r.id DESC`,
        )
        .all() as Row[];
    // 取り残しの局は選ばせない (CURRENT_SERVICES)。もう録れない局が並ぶだけ
    const services = database()
        .prepare(`SELECT * FROM services WHERE ${CURRENT_SERVICES} ORDER BY type, channel`)
        .all() as Service[];
    /*
     * 編集中のルールがこれから録る予定。
     *
     * 条件を狭めても、既に立った予約はそのまま残る(意図して個別に残していることが
     * あるため勝手に消さない)。**1件ずつ取り消せるようにここへ並べる。**
     * まとめて畳む口しか無かった頃は、1つだけ要らない予約を外すのに
     * 全部消してから条件をいじり直すしかなかった
     */
    const pending =
        editing === undefined
            ? []
            : queryAll<PendingRow>(
                  `SELECT r.id, r.name, r.start_at, r.end_at, r.state, s.name AS service_name
                   FROM reservations r
                   JOIN services s ON s.id = r.service_id
                   WHERE r.rule_id = ? AND r.state IN ${PENDING_STATES}
                   ORDER BY r.start_at`,
                  editing.id,
              );
    // フォームの初期値は preview と同じものを使う。別々に組み立てると、
    // 画面に出ている結果と保存されるものがズレる
    return { rules, services, editing: editing ?? null, seed: conditions, preview, defaults, pending };
}

/** 選択されたチャンネルを JSON 配列に。未選択(=全チャンネル)は NULL で表す */
function serviceIds(form: FormData): string | null {
    const ids = form
        .getAll('serviceIds')
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
    return ids.length === 0 ? null : JSON.stringify(ids);
}

/** ジャンル大分類の指定。未選択(=全ジャンル)は NULL で表す */
function genres(form: FormData): string | null {
    // "7" は大分類だけ、"7-0" は中分類まで
    const values = form.getAll('genres').map(String).filter(Boolean);
    return values.length === 0 ? null : JSON.stringify(values);
}

/** 地上波/BS/CS 単位の指定 */
function serviceTypes(form: FormData): string | null {
    const types = form.getAll('serviceTypes').map(String).filter(Boolean);
    return types.length === 0 ? null : JSON.stringify(types);
}

/** キーワードを当てる範囲。全部外れていたら番組名だけに戻す */
function searchFields(form: FormData): string {
    return parseSearchFields(form.getAll('searchFields').join(',')).join(',');
}

const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS', SKY: 'SKY' };

/**
 * ルール名はキーワードから決める。別で名前を付けさせても、結局キーワードと
 * 同じものを打ち込むだけになるため。キーワードが無いときは対象の局で表す。
 */
function ruleName(
    keyword: string,
    types: string | null,
    ids: string | null,
    genreIds: string | null,
    services: Service[],
): string {
    if (keyword !== '') return keyword;
    const parts: string[] = [];
    if (genreIds !== null) parts.push(...(JSON.parse(genreIds) as string[]).map(genreName));
    if (types !== null) parts.push(...(JSON.parse(types) as string[]).map((t) => TYPE_LABEL[t] ?? t));
    if (ids !== null) {
        parts.push(
            ...(JSON.parse(ids) as number[]).map(
                (id) => services.find((s) => s.id === id)?.name ?? String(id),
            ),
        );
    }
    return parts.length === 0
        ? '無題のルール'
        : `${parts.slice(0, 3).join('・')}${parts.length > 3 ? ' ほか' : ''}`;
}

/**
 * ルールを当て直して、チューナーの取り合いを解き直す。
 *
 * 以前はここで番組表を丸ごと取り直していた (`sync()`)。押す動機はたいてい
 * 「新しい番組に当ててほしい」だから、というつもりだったが、そのぶん
 * 数MBの取得と2万件の書き戻しを待たされていた。
 *
 * いまは mirakc が番組表の更新を知らせてくるので (`/events`)、手元の番組表は
 * 常に新しい。取り直す理由がなくなったので当てるだけにする。
 */
async function reapply(): Promise<void> {
    applyRules();
    await resolveConflicts();
}

export const actions = {
    create: async ({ request }) => {
        const form = await request.formData();
        const keyword = String(form.get('keyword') ?? '').trim();
        const ids = serviceIds(form);
        const types = serviceTypes(form);
        const genreIds = genres(form);
        if (keyword === '' && ids === null && types === null && genreIds === null) {
            // 条件が空だと全番組にマッチしてディスクを埋めるので作らせない
            return fail(400, {
                message: 'キーワード・チャンネル・ジャンルのどれかは指定してください',
            });
        }
        const services = queryAll<Service>('SELECT * FROM services');
        const current = settings();
        const name = ruleName(keyword, types, ids, genreIds, services);

        database()
            .prepare(
                `INSERT INTO rules (name, keyword, ignore_keyword, search_fields, service_ids, service_types,
                                genres, free_only, enabled, priority, encode, keep_original, cm_cut, codec, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                name,
                keyword,
                String(form.get('ignoreKeyword') ?? '').trim(),
                searchFields(form),
                ids,
                types,
                genreIds,
                form.get('freeOnly') === 'on' ? 1 : 0,
                Number(form.get('priority') ?? 2) || 2,
                form.get('encode') === 'on' ? 1 : 0,
                form.get('keepOriginal') === 'on' ? 1 : 0,
                current.cmCut,
                current.codec,
                now(),
            );

        await reapply();
        return { success: true };
    },

    update: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ルールIDが不正です' });

        const keyword = String(form.get('keyword') ?? '').trim();
        const ids = serviceIds(form);
        const types = serviceTypes(form);
        const genreIds = genres(form);
        if (keyword === '' && ids === null && types === null && genreIds === null) {
            return fail(400, {
                message: 'キーワード・チャンネル・ジャンルのどれかは指定してください',
            });
        }

        const services = queryAll<Service>('SELECT * FROM services');
        const current = settings();
        database()
            .prepare(
                `UPDATE rules SET name = ?, keyword = ?, ignore_keyword = ?, search_fields = ?, service_ids = ?,
                 service_types = ?, genres = ?, free_only = ?, priority = ?, encode = ?,
                 keep_original = ?, cm_cut = ?, codec = ? WHERE id = ?`,
            )
            .run(
                ruleName(keyword, types, ids, genreIds, services),
                keyword,
                String(form.get('ignoreKeyword') ?? '').trim(),
                searchFields(form),
                ids,
                types,
                genreIds,
                form.get('freeOnly') === 'on' ? 1 : 0,
                Number(form.get('priority') ?? 2) || 2,
                form.get('encode') === 'on' ? 1 : 0,
                form.get('keepOriginal') === 'on' ? 1 : 0,
                current.cmCut,
                current.codec,
                id,
            );

        // 条件が変わったので、これから録るぶんは組み直す。
        // 条件から外れた予約は残しておく(意図して個別に残している場合があるため)
        await reapply();
        redirect(303, '/rules');
    },

    /**
     * このルールが立てた予約を**1件だけ**取り消す。
     *
     * 条件を狭めても既存の予約は残る(意図して個別に残していることがあるため)ので、
     * 要らないものだけここで外す。まとめて畳む口しか無かった頃は、1つだけ外すのに
     * 全部消してから条件をいじり直すことになっていた。
     *
     * 取り消しであって削除ではない。ルールが同じ番組を作り直すことはなく、
     * 気が変わったら予約一覧の「戻す」で戻せる。
     */
    cancelReservation: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('reservationId'));
        if (!Number.isFinite(id)) return fail(400, { message: '予約IDが不正です' });
        await cancel(id);
        return { success: true };
    },

    toggle: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ルールIDが不正です' });
        database().prepare('UPDATE rules SET enabled = 1 - enabled WHERE id = ?').run(id);
        await reapply();
        return { success: true };
    },

    delete: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ルールIDが不正です' });
        // まだ始まっていない予約は行ごと消す。残すと、ルールを消したのに録画だけ続く。
        //
        // 「取り消し」にはしない。applyRules は予約行が既にあると INSERT OR IGNORE で
        // 飛ばすので(手で取り消したものをルールが復活させないため)、取り消しで残すと
        // 同じルールを作り直しても二度と予約が立たなくなる
        const canceled = database()
            .prepare(
                `DELETE FROM reservations
                 WHERE rule_id = ? AND state IN ('scheduled', 'conflict') AND started_at IS NULL`,
            )
            .run(id);
        // 録画中・録画済みのぶんは履歴として残すので、ルールとの紐付けだけ外す
        database().prepare('UPDATE reservations SET rule_id = NULL WHERE rule_id = ?').run(id);
        database().prepare('DELETE FROM rules WHERE id = ?').run(id);

        await resolveConflicts();
        return { success: true, canceled: canceled.changes };
    },

    apply: async () => {
        await reapply();
        return { success: true };
    },
};
