import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
 * 保存先の実体とDBを突き合わせる。**両方向を見る。**
 *
 * - **行はあるが実体が無い。** ファイルマネージャなど外から録画を消すと、DBには
 *   実体の無い行だけが残る。削除済みに倒して一覧から外す
 * - **実体はあるが行が無い。** 動画の付き添い (索引・字幕・NFO・サムネイル) は
 *   動画と同じ名前で隣に置くので、動画が消えたあとに取り残されることがある
 *
 * **動画そのものには触らない。** 行の無い動画は、手で置いたものかもしれない。
 * 数だけ数えて、消すかどうかは人が決める。
 */
export function reconcile(): { checked: number; removed: number; swept: number; strays: number } {
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

    const left = sweepLeftovers();
    return { checked: recordings.length, removed, ...left };
}

/** 動画そのもの。これに付き添うものが「付き添い」 */
const VIDEO = /\.(m2ts|ts|mkv|mp4)$/i;

/**
 * 触らずに置いておく、書きたてのもの。
 *
 * **これから連れ合いになるファイルを巻き添えにしないため。** 名前だけで
 * 「連れ合いが居ない」と決めているので、*まだ出来ていない動画*の付き添いは
 * 全部そう見える。エンコードは出来上がるまで `<最終の名前>.encoding` に書いていて、
 * その `.mkv` はまだどこにも無い。実機では**焼いている途中のものが5分ごとに
 * 消され**、ffmpeg は開いたままの fd に書き終えて 0 で帰り、置き換えるところで
 * `ENOENT ... rename` になっていた。
 *
 * 書いている最中なら更新時刻が新しいので、そこで避ける。名前で除外しないのは、
 * 作業ファイルの名前がこの先も増えるため。**落ちて取り残されたものも、
 * しばらく経てば普通に片付く。**
 */
const SETTLE = 60 * 60_000;

/** まだ書いている最中かもしれないもの。**読めないものも触らない** */
function settling(path: string, at: number): boolean {
    try {
        return at - statSync(path).mtimeMs < SETTLE;
    } catch {
        return true;
    }
}

/**
 * 連れ合いを失った付き添いを片付ける。
 *
 * 付き添いは**動画と同じ名前で隣に置く**決まりなので、名前から連れ合いが分かる。
 *
 * - `<動画>.dtvi` … chapter_exe / logoframe が作る索引 (1本3MB)
 * - `<動画>.sup` `<動画>.jls…` … 字幕とCM検出の作業ファイル
 * - `<動画から拡張子を取ったもの>.nfo` / `-thumb.jpg` … プレイヤー向けの覚え書き
 *
 * 実機では生TSの置き場に `.dtvi` が9本 (22MB) 残っていた。生TSを残さない設定だと
 * TS が消えたあとも索引だけが居座り、録るたびに積もる。
 */
function sweepLeftovers(): { swept: number; strays: number } {
    const known = new Set(
        queryAll<{ path: string | null }>(
            `SELECT ts_path AS path FROM recordings WHERE ts_path IS NOT NULL
             UNION SELECT library_path FROM recordings WHERE library_path IS NOT NULL`,
        ).map((row) => row.path as string),
    );

    const at = now();
    let swept = 0;
    let strays = 0;
    for (const root of [config.recordedDir, config.libraryDir]) {
        const files = walk(root);
        const videos = new Set(files.filter((path) => VIDEO.test(path)));
        for (const path of videos) {
            // 動画は消さない。手で置いたものかもしれないので、数えるだけ。
            // 焼いている途中の切り出し (`<入力>.cut.ts`) を数に入れないよう、書きたては飛ばす
            if (!known.has(path) && !settling(path, at)) strays++;
        }
        for (const path of files) {
            if (videos.has(path)) continue;
            if (!orphan(path, videos)) continue;
            if (settling(path, at)) continue;
            removeIfExists(path);
            pruneEmptyDirs(path);
            swept++;
        }
    }
    if (swept > 0) console.log(`[files] 連れ合いの無い付き添いを片付けました: ${swept} 件`);
    return { swept, strays };
}

/** シリーズ全体の覚え書き。エピソードが1つでも残っていれば要る */
const SHOW_NFO = 'tvshow.nfo';

/** 付き添いで、かつ連れ合いの動画が1つも無いか */
function orphan(path: string, videos: Set<string>): boolean {
    if (basename(path) === SHOW_NFO) {
        // シリーズのフォルダに動画が1つでも残っていれば置いておく
        const show = `${dirname(path)}/`;
        return ![...videos].some((video) => video.startsWith(show));
    }
    // 索引や作業ファイル。動画の名前をまるごと頭に持つ (`….m2ts.dtvi`)
    const trailing = /^(.+\.(?:m2ts|ts|mkv|mp4))\.[^/]+$/i.exec(path);
    if (trailing !== null) return !videos.has(trailing[1]);
    // NFO とサムネイル。動画の拡張子を取り替えた形 (`….nfo` / `…-thumb.jpg`)
    const base = /^(.+?)(?:-thumb\.jpg|\.nfo)$/i.exec(path);
    if (base === null) return false;
    // どの入れ物で置いたかまでは名前から分からないので、当てはまるものを全部見る
    return !['m2ts', 'ts', 'mkv', 'mp4'].some((extension) => videos.has(`${base[1]}.${extension}`));
}

function walk(dir: string, out: string[] = []): string[] {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        // 置き場がまだ無い。片付けるものも無い
        return out;
    }
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, out);
        else out.push(path);
    }
    return out;
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
