import { fail } from '@sveltejs/kit';
import { isCmMode } from '$lib/server/cm';
import { config } from '$lib/server/config';
import { database, now } from '$lib/server/db';
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

/** 複数選択されたチャンネルを JSON 配列に。未選択(=全チャンネル)は NULL で表す */
function serviceIds(form: FormData): string | null {
    const ids = form
        .getAll('serviceIds')
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
    return ids.length === 0 ? null : JSON.stringify(ids);
}

async function reapply(): Promise<void> {
    applyRules();
    await resolveConflicts();
}

export const actions = {
    create: async ({ request }) => {
        const form = await request.formData();
        const name = String(form.get('name') ?? '').trim();
        const keyword = String(form.get('keyword') ?? '').trim();
        const ids = serviceIds(form);
        if (name === '') return fail(400, { message: 'ルール名を入力してください' });
        if (keyword === '' && ids === null) {
            // 条件が空だと全番組にマッチしてディスクを埋めるので作らせない
            return fail(400, { message: 'キーワードかチャンネルのどちらかは指定してください' });
        }

        const cmCut = form.get('cmCut');
        const codec = form.get('codec');
        database()
            .prepare(
                `INSERT INTO rules (name, keyword, ignore_keyword, service_ids, genres, free_only,
                                enabled, priority, encode, keep_original, cm_cut, codec, created_at)
             VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                name,
                keyword,
                String(form.get('ignoreKeyword') ?? '').trim(),
                ids,
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
