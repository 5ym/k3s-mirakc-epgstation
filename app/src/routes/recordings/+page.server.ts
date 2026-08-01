import { fail } from '@sveltejs/kit';
import { database, now, queryAll, queryOne } from '$lib/server/db';
import { cancel as cancelEncode, enqueue, pump } from '$lib/server/encoder';
import { deleteRecordingFiles, reconcile, refreshLibrary } from '$lib/server/jellyfin';
import type { EncodeJob, Recording } from '$lib/types';

interface JobRow extends EncodeJob {
    recording_name: string;
}

export function load({ url }) {
    const showDeleted = url.searchParams.get('deleted') === '1';
    const recordings = database()
        .prepare(
            `SELECT * FROM recordings
             WHERE deleted_at IS ${showDeleted ? 'NOT NULL' : 'NULL'}
             ORDER BY start_at DESC LIMIT 300`,
        )
        .all() as Recording[];
    // エンコードは「ライブラリに入る途中の状態」なので同じ画面の上に出す。
    // 終わったものは録画側の行に出るので、ここは進行中と直近の失敗だけ
    const jobs = queryAll<JobRow>(
        `SELECT j.*, r.name AS recording_name
         FROM encode_jobs j JOIN recordings r ON r.id = j.recording_id
         WHERE j.state IN ('queued','running')
            OR (j.state IN ('failed','canceled') AND j.finished_at > ?)
         ORDER BY
            CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
            j.id DESC
         LIMIT 50`,
        Date.now() - 24 * 60 * 60 * 1000,
    );

    return { recordings, jobs, showDeleted };
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

    cancelEncode: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ジョブIDが不正です' });
        cancelEncode(id);
        return { success: true };
    },

    retryEncode: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ジョブIDが不正です' });
        const job = queryOne<EncodeJob>('SELECT * FROM encode_jobs WHERE id = ?', id);
        if (job === undefined) return fail(400, { message: 'ジョブが見つかりません' });

        const source = queryOne<{ ts_path: string | null }>(
            'SELECT ts_path FROM recordings WHERE id = ?',
            job.recording_id,
        );
        if (source?.ts_path == null) {
            return fail(400, { message: '生TSが残っていないためやり直せません' });
        }

        database()
            .prepare(
                `UPDATE encode_jobs SET state = 'queued', percent = 0, error = NULL,
                 started_at = NULL, finished_at = NULL WHERE id = ?`,
            )
            .run(id);
        database()
            .prepare(`UPDATE recordings SET state = 'recorded', error = NULL, updated_at = ? WHERE id = ?`)
            .run(now(), job.recording_id);
        pump();
        return { success: true };
    },

    dismissEncode: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ジョブIDが不正です' });
        // 失敗の記録は録画側の error に残るので、ジョブ行は消してしまってよい
        database().prepare(`DELETE FROM encode_jobs WHERE id = ? AND state IN ('failed','canceled')`).run(id);
        return { success: true };
    },

    reconcile: () => {
        // 「ライブラリを照合」ボタン。Jellyfin で消した分をすぐ一覧に反映したいとき用
        return { success: true, reconcile: reconcile() };
    },
};
