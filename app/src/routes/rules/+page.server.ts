import { fail } from '@sveltejs/kit';
import { isCmMode } from '$lib/server/cm';
import { config } from '$lib/server/config';
import { database, now, queryAll } from '$lib/server/db';
import { isVideoCodec } from '$lib/server/encoder';
import { applyRules, matches } from '$lib/server/rules';
import { resolveConflicts } from '$lib/server/scheduler';
import type { Program, Rule, Service } from '$lib/types';

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

/** 入力中の条件で、これから何が録れるのかを見せる */
function previewFor(rule: Rule, limit = 30): { total: number; programs: PreviewRow[] } {
    const programs = queryAll<Program & { service_type: string; service_name: string }>(
        `SELECT p.*, s.type AS service_type, s.name AS service_name FROM programs p
         JOIN services s ON s.id = p.service_id
         WHERE p.start_at > ? ORDER BY p.start_at`,
        now(),
    );
    const hits = programs.filter((p) => matches(rule, p, p.service_type));
    return {
        total: hits.length,
        programs: hits.slice(0, limit).map((p) => ({
            id: p.id,
            name: p.name,
            service_name: p.service_name,
            start_at: p.start_at,
            end_at: p.end_at,
        })),
    };
}

export interface PreviewRow {
    id: number;
    name: string;
    service_name: string;
    start_at: number;
    end_at: number;
}

/** プレビュー用に、保存していないルールをフォームから組み立てる */
function formToRule(form: FormData): Rule | null {
    const keyword = String(form.get('keyword') ?? '').trim();
    const ids = serviceIds(form);
    const types = serviceTypes(form);
    if (keyword === '' && ids === null && types === null) return null;
    return {
        id: 0,
        name: '',
        keyword,
        ignore_keyword: String(form.get('ignoreKeyword') ?? '').trim(),
        service_ids: ids,
        service_types: types,
        genres: null,
        free_only: form.get('freeOnly') === 'on' ? 1 : 0,
        enabled: 1,
        priority: 2,
        encode: 1,
        keep_original: 0,
        cm_cut: 'chapter',
        codec: 'av1',
        created_at: 0,
    };
}

async function reapply(): Promise<void> {
    applyRules();
    await resolveConflicts();
}

export const actions = {
    /** 追加せずに、いまの条件で何が録れるかだけ見る */
    preview: async ({ request }) => {
        const form = await request.formData();
        const rule = formToRule(form);
        if (rule === null) {
            return fail(400, { message: 'キーワードかチャンネルのどちらかは指定してください' });
        }
        return { success: true, preview: previewFor(rule) };
    },

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
        database().prepare('DELETE FROM rules WHERE id = ?').run(id);
        // ルールを消しても、これから録るぶんの予約は残す(消したい場合は予約側で取り消す)
        database().prepare('UPDATE reservations SET rule_id = NULL WHERE rule_id = ?').run(id);
        return { success: true };
    },

    apply: async () => {
        await reapply();
        return { success: true };
    },
};
