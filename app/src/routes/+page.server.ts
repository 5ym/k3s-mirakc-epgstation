import { fail } from '@sveltejs/kit';
import { enabled as authEnabled } from '$lib/server/auth';
import { database, now, queryAll, queryOne } from '$lib/server/db';
import { cancel as cancelEncode, enqueue, pump } from '$lib/server/encoder';
import { deleteRecordingFiles, reconcile } from '$lib/server/files';
import { cancel } from '$lib/server/reservations';
import { resolveConflicts } from '$lib/server/scheduler';
import { settings } from '$lib/server/settings';
import type { EncodeJob, Recording, Reservation } from '$lib/types';

interface JobRow extends EncodeJob {
    recording_name: string;
}

interface ReservationRow extends Reservation {
    service_name: string;
    rule_name: string | null;
}

/**
 * 予約と録画を1画面に並べる。
 *
 * 「これから何が録れるか」と「録れたものが今どうなっているか」は続きものなので、
 * 行き来せずに見えるほうがいい。左に予約、右に録画。
 */
export function load({ url }) {
    const showFinished = url.searchParams.get('all') === '1';
    const showDeleted = url.searchParams.get('deleted') === '1';

    const states = showFinished
        ? "('scheduled','conflict','recording','done','failed','canceled','missed')"
        : "('scheduled','conflict','recording')";
    const reservations = queryAll<ReservationRow>(
        `SELECT r.*, s.name AS service_name, rules.name AS rule_name
         FROM reservations r
         JOIN services s ON s.id = r.service_id
         LEFT JOIN rules ON rules.id = r.rule_id
         WHERE r.state IN ${states}
         -- 録画中は真っ先に見たいので先頭に固定する
         ORDER BY (r.state = 'recording') DESC, r.start_at ${showFinished ? 'DESC' : 'ASC'}
         LIMIT 300`,
    );

    const recordings = database()
        .prepare(
            `SELECT * FROM recordings
             WHERE deleted_at IS ${showDeleted ? 'NOT NULL' : 'NULL'}
             -- 進行中のものは上のエンコード欄と予約一覧に出ている。
             -- ここにも出すと同じ番組が2箇所に並ぶので、落ち着いたものだけ出す
             AND state NOT IN ('recording', 'encoding')
             -- エンコード待ちは状態が動くので先頭に固定する
             ORDER BY (state = 'recorded') DESC, start_at DESC
             LIMIT 300`,
        )
        .all() as Recording[];

    // エンコードは「ライブラリに入る途中の状態」なので録画側の上に出す。
    // 終わったものは録画の行に出るので、ここは進行中と直近の失敗だけ
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

    return {
        reservations,
        recordings,
        jobs,
        showFinished,
        showDeleted,
        /*
         * プレイヤーに渡すURLに埋める資格情報。
         * mpv も Infuse もベーシック認証のダイアログを出さないので、URL に入れるしかない。
         *
         * BASIC_AUTH_SCOPE=files だとこの画面自体は素通しなので、画面を開ければ
         * パスワードも見える。画面の前段に別の認証を置いている前提の設定。
         */
        credentials: authEnabled()
            ? { user: settings().basicAuthUser, password: settings().basicAuthPassword }
            : undefined,
    };
}

/** フォームの id から録画を引く。どのアクションも最初にこれを通る */
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
        // 「ライブラリを照合」ボタン。外から消した分をすぐ一覧に反映したいとき用
        return { success: true, reconcile: reconcile() };
    },

    cancel: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: '予約IDが不正です' });
        await cancel(id);
        return { success: true };
    },

    resolve: async () => {
        await resolveConflicts();
        return { success: true };
    },
};
