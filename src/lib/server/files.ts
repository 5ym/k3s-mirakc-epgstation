import { existsSync } from 'node:fs';
import type { Recording } from '../types';
import { config } from './config';
import { database, now, queryAll } from './db';
import { pruneEmptyDirs, removeIfExists } from './fsx';
import { removeSidecars } from './metadata';

/**
 * 録画ファイルの実体まわり。
 *
 * 削除は denpa の画面から行う。外から(ファイルマネージャや別のマシンから)
 * 消されることもあるので、DBと実体を突き合わせて消えたものを一覧から落とす仕組みも持つ。
 */

export function deleteRecordingFiles(recording: Recording, reason: string): void {
    if (recording.library_path !== null) {
        removeIfExists(recording.library_path);
        // .nfo を取り残すと、.nfo を読むプレイヤーに中身の無いエピソードが並び続ける
        removeSidecars(recording.library_path);
        pruneEmptyDirs(recording.library_path);
    }
    removeIfExists(recording.ts_path);
    // 失敗した録画を消したときに理由を上書きすると、なぜ失敗したのかが分からなくなる。
    // 元の理由があるならそちらを残す
    database()
        .prepare(
            `UPDATE recordings SET deleted_at = ?, library_path = NULL, ts_path = NULL,
             error = COALESCE(NULLIF(error, ''), ?), updated_at = ? WHERE id = ?`,
        )
        .run(now(), reason, now(), recording.id);
}

/**
 * 保存先の実体とDBを突き合わせる。
 *
 * ファイルマネージャなど外から録画を消すと、DBには実体の無い行だけが残る。それを削除済みに
 * 倒して一覧から外し、空になったシリーズ/シーズンのフォルダも畳む。
 * 消えたものだけを見て、DBに無いファイルには触らない(手で置いたものを消さないため)。
 */
export function reconcile(): { checked: number; removed: number } {
    const recordings = queryAll<Recording>(
        `SELECT * FROM recordings WHERE library_path IS NOT NULL AND deleted_at IS NULL`,
    );

    let removed = 0;
    for (const recording of recordings) {
        if (existsSync(recording.library_path!)) continue;
        deleteRecordingFiles(recording, '保存先から消えていました');
        removed++;
        console.log(`[files] 保存先から消えていたので削除済みにしました: ${recording.name}`);
    }

    return { checked: recordings.length, removed };
}

/**
 * 古い履歴を捨てる。
 *
 * 残すのは「録れたか」を後から確かめるためだけなので、期限を切って畳む。
 * 対象は**終わった予約**と**消した録画の行**だけ。ファイルが残っているものには
 * 触らない(消すかどうかはユーザーが決めること)。
 */
export function pruneHistory(): { reservations: number; recordings: number; jobs: number } {
    const cutoff = now() - config.historyRetention;

    /*
     * 録画中や予約中のものは、いつ立てたかに関係なく残す。
     * 「終わった予約」は**取り消し・録り逃しか、もう録り始めたもの**。
     * 録り始めたあとの顛末は録画の行が持っているので、予約側では見ない
     */
    const reservations = database()
        .prepare(
            `DELETE FROM reservations
             WHERE (state IN ('canceled', 'missed') OR started_at IS NOT NULL) AND end_at < ?`,
        )
        .run(cutoff).changes;

    // 実体はもう無い (deleted_at が立つときに消してある)
    const recordings = database()
        .prepare('DELETE FROM recordings WHERE deleted_at IS NOT NULL AND deleted_at < ?')
        .run(cutoff).changes;

    // 録画の行を消したら、ぶら下がっていたエンコードの記録も要らない
    database().prepare('DELETE FROM encode_jobs WHERE recording_id NOT IN (SELECT id FROM recordings)').run();

    /*
     * 終わったエンコードの記録も期限を切る。
     *
     * 録画の行が残っている限り消していなかったので、失敗のたびに1行ずつ積もり続けていた
     * (実機で失敗22件)。**いちばん新しい1件だけは残す。** 一覧はそれを見て
     * 「いま失敗しているか」を決めているため、消してしまうと状態が読めなくなる。
     */
    const jobs = database()
        .prepare(
            `DELETE FROM encode_jobs
             WHERE state IN ('done', 'failed', 'canceled')
               AND COALESCE(finished_at, created_at) < ?
               AND id NOT IN (SELECT MAX(id) FROM encode_jobs GROUP BY recording_id)`,
        )
        .run(cutoff).changes;

    if (reservations > 0 || recordings > 0 || jobs > 0) {
        console.log(
            `[files] 古い履歴を片付けました: 予約 ${reservations} 件 / 録画 ${recordings} 件 / エンコード ${jobs} 件`,
        );
    }
    return { reservations, recordings, jobs };
}
