import { existsSync } from 'node:fs';
import type { Recording } from '../types';
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
