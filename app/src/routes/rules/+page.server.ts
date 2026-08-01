import { fail } from '@sveltejs/kit';
import { isCmMode } from '$lib/server/cm';
import { config } from '$lib/server/config';
import { database, now, queryAll } from '$lib/server/db';
import { isVideoCodec } from '$lib/server/encoder';
import { applyRules } from '$lib/server/rules';
import { resolveConflicts } from '$lib/server/scheduler';
import type { Rule, Service } from '$lib/types';

interface Row extends Rule {
    reservations: number;
}

export function load() {
    const rules = database()
        .prepare(
            `SELECT r.*, (SELECT COUNT(*) FROM reservations WHERE rule_id = r.id) AS reservations
             FROM rules r ORDER BY r.id DESC`,
        )
        .all() as Row[];
    const services = database().prepare('SELECT * FROM services ORDER BY type, channel').all() as Service[];
    return { rules, services };
}

/** 選択されたチャンネルを JSON 配列に。未選択(=全チャンネル)は NULL で表す */
function serviceIds(form: FormData): string | null {
    const ids = form
        .getAll('serviceIds')
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
    return ids.length === 0 ? null : JSON.stringify(ids);
}

/** 地上波/BS/CS 単位の指定 */
function serviceTypes(form: FormData): string | null {
    const types = form.getAll('serviceTypes').map(String).filter(Boolean);
    return types.length === 0 ? null : JSON.stringify(types);
}

const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS', SKY: 'SKY' };

/**
 * ルール名はキーワードから決める。別で名前を付けさせても、結局キーワードと
 * 同じものを打ち込むだけになるため。キーワードが無いときは対象の局で表す。
 */
function ruleName(keyword: string, types: string | null, ids: string | null, services: Service[]): string {
    if (keyword !== '') return keyword;
    const parts: string[] = [];
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
        if (keyword === '' && ids === null && types === null) {
            // 条件が空だと全番組にマッチしてディスクを埋めるので作らせない
            return fail(400, { message: 'キーワードかチャンネルのどちらかは指定してください' });
        }
        const services = queryAll<Service>('SELECT * FROM services');
        const name = ruleName(keyword, types, ids, services);

        const cmCut = form.get('cmCut');
        const codec = form.get('codec');
        database()
            .prepare(
                `INSERT INTO rules (name, keyword, ignore_keyword, service_ids, service_types, genres,
                                free_only, enabled, priority, encode, keep_original, cm_cut, codec, created_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                name,
                keyword,
                String(form.get('ignoreKeyword') ?? '').trim(),
                ids,
                types,
                form.get('freeOnly') === 'on' ? 1 : 0,
                Number(form.get('priority') ?? 2) || 2,
                form.get('encode') === 'on' ? 1 : 0,
                form.get('keepOriginal') === 'on' ? 1 : 0,
                isCmMode(cmCut) ? cmCut : config.cmCutDefault,
                isVideoCodec(codec) ? codec : config.encodeCodec,
                now(),
            );

        await reapply();
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
        // まだ始まっていない予約は一緒に取り消す。
        // 残すと、ルールを消したのに録画だけ続くことになる
        const canceled = database()
            .prepare(
                `UPDATE reservations SET state = 'canceled', updated_at = ?
                 WHERE rule_id = ? AND state IN ('scheduled', 'conflict')`,
            )
            .run(now(), id);
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
