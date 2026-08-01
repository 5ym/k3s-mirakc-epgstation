import { fail } from '@sveltejs/kit';
import { database, queryOne } from '$lib/server/db';
import { enqueue, pump } from '$lib/server/encoder';
import { deleteRecordingFiles, reconcile, refreshLibrary } from '$lib/server/jellyfin';
import type { Recording } from '$lib/types';

export function load({ url }) {
    const showDeleted = url.searchParams.get('deleted') === '1';
    const recordings = database()
        .prepare(
            `SELECT * FROM recordings
             WHERE deleted_at IS ${showDeleted ? 'NOT NULL' : 'NULL'}
             ORDER BY start_at DESC LIMIT 300`,
        )
        .all() as Recording[];
    return { recordings, showDeleted };
}

function target(form: FormData): Recording | undefined {
    const id = Number(form.get('id'));
    if (!Number.isFinite(id)) return undefined;
    return queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', id);
}

export const actions = {
    delete: async ({ request }) => {
        const recording = target(await request.formData());
        if (recording === undefined) return fail(400, { message: '録画が見つかりません' });
        deleteRecordingFiles(recording, '手動削除');
        // 待たないと Jellyfin 側に消えたはずの録画が残り続ける
        await refreshLibrary();
        return { success: true };
    },

    reencode: async ({ request }) => {
        const recording = target(await request.formData());
        if (recording === undefined) return fail(400, { message: '録画が見つかりません' });
        if (recording.ts_path === null) {
            return fail(400, { message: '生TSが残っていないため再エンコードできません' });
        }
        enqueue(recording.id);
        pump();
        return { success: true };
    },

    reconcile: () => {
        // 「ライブラリを照合」ボタン。Jellyfin で消した分をすぐ一覧に反映したいとき用
        return { success: true, reconcile: reconcile() };
    },
};
