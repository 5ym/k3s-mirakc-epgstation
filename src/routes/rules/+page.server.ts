import { fail, redirect } from '@sveltejs/kit';
import { genreName } from '$lib/arib';
import { parseSearchFields } from '$lib/search';
import { config } from '$lib/server/config';
import { contending, type Occupant, rivalsOf } from '$lib/server/conflict';
import { database, now, queryAll, queryOne } from '$lib/server/db';
import { CURRENT_SERVICES } from '$lib/server/epg';
import { cancel } from '$lib/server/reservations';
import { applyRules, compile, haystack, matchesCompiled } from '$lib/server/rules';
import { resolveConflicts, tunerCapacity } from '$lib/server/scheduler';
import { settings } from '$lib/server/settings';
import type { Program, Rule, Service } from '$lib/types';

interface Row extends Rule {
    reservations: number;
}

/**
 * まだ録っていないぶん。終わったものも取り消したものも数えない。
 *
 * 予約の行は録り始めたかどうかを `started_at` で持っている (状態の文字列には
 * 書かない)。`state IN ('scheduled','conflict')` だけで数えていた頃は、
 * 録り終えた予約まで「押さえている」に入っていた
 */
const PENDING = "(state IN ('scheduled', 'conflict') AND started_at IS NULL)";

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
        // 無料放送の扱いは**全体設定**。ルールごとには持たない (誰も読まない列)
        enabled: 1,
        priority: 2,
        source: null,
        created_at: 0,
    };
}

/**
 * 「この条件で録れる番組」の1行。
 *
 * **予約とプレビューは同じ表に出す。** 別々に並べていた頃は、同じ番組が2箇所に
 * 出るうえ、「押さえている予約」と「これから当たる番組」を頭の中で突き合わせる
 * ことになっていた。1本の時系列にして、その番組がいまどうなっているかを行に書く。
 */
export interface PreviewRow {
    id: number;
    name: string;
    service_name: string;
    start_at: number;
    end_at: number;
    /** 立っている予約。取り消せるように id も持つ */
    reservation_id: number | null;
    reservation_state: string | null;
    /** いまの条件に当たるか。false なら「条件から外れたが予約は残っている」 */
    matched: boolean;
    /** チューナーを取り合う他の番組。**全部**入れる。取り合わなければ空 */
    conflicts: string[];
    /** スケジューラが既にチューナー不足と判断していれば、その理由 */
    conflict_reason: string | null;
}

interface Pending {
    id: number;
    rule_id: number | null;
    program_id: number;
    name: string;
    service_id: number;
    service_name: string;
    /** チャンネル種別 (GR/BS/CS)。チューナーはこの単位で本数が決まる */
    type: string;
    /** 物理チャンネル。同じチャンネルなら1本のチューナーで足りる */
    channel: string;
    start_at: number;
    end_at: number;
    state: string;
    conflict_reason: string | null;
}

export async function load({ url }) {
    const defaults = settings();
    /*
     * チューナーの本数。**スケジューラと同じところから取る。**
     * 取れなければ空 (= 何も競合として出さない)。mirakc が落ちているときに
     * 予約表を赤くしても直しようが無いので、スケジューラもそう振る舞う
     */
    const capacity = await tunerCapacity().catch(() => new Map<string, number>());
    // 掴む区間は前後マージンぶん延びる。スケジューラと同じ物差しで数える
    const margins = { start: config.startMargin, end: config.endMargin };
    // ?edit=<id> のときは、そのルールをフォームに読み込んで書き換えられるようにする
    const editing = queryOne<Rule>('SELECT * FROM rules WHERE id = ?', Number(url.searchParams.get('edit')));

    /** まだ録っていない予約。重なりの判定と、条件から外れた予約を出すのに使う */
    const pending = queryAll<Pending>(
        `SELECT r.id, r.rule_id, r.program_id, r.name, r.service_id, r.start_at, r.end_at, r.state,
                r.conflict_reason, s.name AS service_name, s.type AS type, s.channel AS channel
         FROM reservations r
         JOIN services s ON s.id = r.service_id
         WHERE r.state IN ('scheduled', 'conflict') AND r.started_at IS NULL
         ORDER BY r.start_at`,
    );
    const reserved = new Map(pending.map((row) => [row.program_id, row]));

    /*
     * 条件が入っていれば、その条件で録れる番組を出す。
     *
     * URL に載っている条件を優先する。編集中に「この条件で何が録れるか見る」を押すと
     * ?edit=<id> と書き換えたフォームの値が一緒に飛んでくるので、保存済みのほうを
     * 使うと**いま画面に入っている条件ではない結果**が出てしまう。
     */
    const conditions = conditionsFrom(url.searchParams) ?? editing ?? null;
    let preview: { total: number; programs: PreviewRow[]; conflicts: number } | null = null;
    if (conditions !== null && url.searchParams.size > 0) {
        const all = queryAll<
            Program & { service_type: string; service_name: string; service_channel: string }
        >(
            `SELECT p.*, s.type AS service_type, s.name AS service_name, s.channel AS service_channel
             FROM programs p
             JOIN services s ON s.id = p.service_id
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

        /*
         * 重なりを数える相手。**立っている予約と、この条件で録れる番組の両方。**
         *
         * 予約としか比べていなかった頃は、保存前のルールでは重なりが1件も
         * 出なかった (比べる相手がまだ居ない)。同じ番組が両方に出てくるので、
         * 番組IDで1つにまとめる
         */
        const occupants = new Map<number, Occupant>();
        for (const p of hits) {
            occupants.set(p.id, {
                programId: p.id,
                name: p.name,
                serviceName: p.service_name,
                type: p.service_type,
                channel: p.service_channel,
                start_at: p.start_at,
                end_at: p.end_at,
            });
        }
        for (const row of pending) {
            occupants.set(row.program_id, {
                programId: row.program_id,
                name: row.name,
                serviceName: row.service_name,
                type: row.type,
                channel: row.channel,
                start_at: row.start_at,
                end_at: row.end_at,
            });
        }
        const rivals = rivalsOf(occupants.values(), margins);

        const rows: PreviewRow[] = hits.map((p) => {
            const held = reserved.get(p.id) ?? null;
            return {
                id: p.id,
                name: p.name,
                service_name: p.service_name,
                start_at: p.start_at,
                end_at: p.end_at,
                reservation_id: held?.id ?? null,
                reservation_state: held?.state ?? null,
                matched: true,
                /*
                 * 重なりは**録ろうとした時点で初めて分かる**ので先に見せる。
                 * スケジューラが既にチューナー不足と判断していれば、その理由も
                 * 添える (何本足りないのかはあちらしか知らない)
                 */
                conflicts: contending(
                    {
                        programId: p.id,
                        type: p.service_type,
                        channel: p.service_channel,
                        start_at: p.start_at,
                        end_at: p.end_at,
                    },
                    rivals,
                    capacity,
                    margins,
                ),
                conflict_reason:
                    held?.state === 'conflict' ? (held.conflict_reason ?? 'チューナーが足りません') : null,
            };
        });

        /*
         * 条件から外れたのに残っている予約も同じ表に混ぜる。
         *
         * 条件を狭めても、既に立った予約はそのまま残る (意図して個別に残している
         * ことがあるので勝手には消さない)。別の表に出していた頃は、
         * 同じ番組が2箇所に並び、どちらを見ればいいのか分からなかった
         */
        if (editing !== undefined) {
            const shown = new Set(rows.map((row) => row.id));
            for (const held of pending) {
                if (shown.has(held.program_id)) continue;
                if (held.rule_id !== editing.id) continue;
                rows.push({
                    id: held.program_id,
                    name: held.name,
                    service_name: held.service_name,
                    start_at: held.start_at,
                    end_at: held.end_at,
                    reservation_id: held.id,
                    reservation_state: held.state,
                    matched: false,
                    conflicts: contending(
                        {
                            programId: held.program_id,
                            type: held.type,
                            channel: held.channel,
                            start_at: held.start_at,
                            end_at: held.end_at,
                        },
                        rivals,
                        capacity,
                        margins,
                    ),
                    conflict_reason:
                        held.state === 'conflict' ? (held.conflict_reason ?? 'チューナーが足りません') : null,
                });
            }
        }
        rows.sort((a, b) => a.start_at - b.start_at);

        preview = {
            total: rows.length,
            // 数えるのは**行の数**。1行に3本重なっていても、困っている番組は1つ
            conflicts: rows.filter((row) => row.conflicts.length > 0 || row.conflict_reason !== null).length,
            programs: rows.slice(0, 100),
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
                 WHERE rule_id = r.id AND ${PENDING}
             ) AS reservations
             FROM rules r ORDER BY r.id DESC`,
        )
        .all() as Row[];
    // 取り残しの局は選ばせない (CURRENT_SERVICES)。もう録れない局が並ぶだけ
    const services = database()
        .prepare(`SELECT * FROM services WHERE ${CURRENT_SERVICES} ORDER BY type, channel`)
        .all() as Service[];
    // フォームの初期値は preview と同じものを使う。別々に組み立てると、
    // 画面に出ている結果と保存されるものがズレる
    return { rules, services, editing: editing ?? null, seed: conditions, preview, defaults };
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
        const name = ruleName(keyword, types, ids, genreIds, services);

        database()
            .prepare(
                // 焼き方は書かない。エンコードもCMも全体設定で、焼くときに読む
                `INSERT INTO rules (name, keyword, ignore_keyword, search_fields, service_ids, service_types,
                                genres, enabled, priority, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
                name,
                keyword,
                String(form.get('ignoreKeyword') ?? '').trim(),
                searchFields(form),
                ids,
                types,
                genreIds,
                Number(form.get('priority') ?? 2) || 2,
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
        database()
            .prepare(
                // 焼き方は触らない。エンコードもCMも全体設定で、焼くときに読む
                `UPDATE rules SET name = ?, keyword = ?, ignore_keyword = ?, search_fields = ?, service_ids = ?,
                 service_types = ?, genres = ?, priority = ? WHERE id = ?`,
            )
            .run(
                ruleName(keyword, types, ids, genreIds, services),
                keyword,
                String(form.get('ignoreKeyword') ?? '').trim(),
                searchFields(form),
                ids,
                types,
                genreIds,
                Number(form.get('priority') ?? 2) || 2,
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
