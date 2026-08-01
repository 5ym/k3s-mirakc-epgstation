import { fail } from '@sveltejs/kit';
import { db, now, queryOne } from '$lib/server/db';
import { cancel, pump } from '$lib/server/encoder';
import type { EncodeJob } from '$lib/types';

interface Row extends EncodeJob {
    recording_name: string;
    recording_state: string;
}

export function load() {
    const jobs = db
        .prepare(
            `SELECT j.*, r.name AS recording_name, r.state AS recording_state
             FROM encode_jobs j JOIN recordings r ON r.id = j.recording_id
             ORDER BY
                CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                j.id DESC
             LIMIT 200`,
        )
        .all() as Row[];
    return { jobs };
}

export const actions = {
    cancel: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ジョブIDが不正です' });
        cancel(id);
        return { success: true };
    },

    retry: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ジョブIDが不正です' });
        const job = queryOne<EncodeJob>('SELECT * FROM encode_jobs WHERE id = ?', id);
        if (job === undefined) return fail(400, { message: 'ジョブが見つかりません' });

        const recording = queryOne<{ ts_path: string | null }>(
            'SELECT ts_path FROM recordings WHERE id = ?',
            job.recording_id,
        );
        if (recording?.ts_path == null) {
            return fail(400, { message: '生TSが残っていないためやり直せません' });
        }

        db.prepare(
            `UPDATE encode_jobs SET state = 'queued', percent = 0, error = NULL,
             started_at = NULL, finished_at = NULL WHERE id = ?`,
        ).run(id);
        db.prepare(`UPDATE recordings SET state = 'recorded', error = NULL, updated_at = ? WHERE id = ?`).run(
            now(),
            job.recording_id,
        );
        pump();
        return { success: true };
    },
};
