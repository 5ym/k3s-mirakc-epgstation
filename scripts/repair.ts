/**
 * 引き継ぎのときに崩れたデータを直す。
 *
 * 移行のロジック自体は直してあるので、これから引き継ぐ人には要らない。
 * **既に引き継いでしまった環境を直すためだけ**のもので、直したら消してよい。
 *
 *   bun scripts/repair.ts          # 何をするかを出すだけ
 *   bun scripts/repair.ts --apply  # 実際に直す
 *
 * 直すのは2つ。
 *
 * 1. ルールのジャンル指定 … 引けない値が混ざっていると画面のジャンル欄が読めなくなる
 * 2. 保存先に入ってしまった生TS … 作業領域に移して ts_path に付け替える
 *    (denpa 自身が録ったときと同じ形。こうしないと録り直せず、Kodi にも
 *     巨大な MPEG-2 が並ぶ)
 *
 * DBと置き場は denpa 本体と同じ環境変数で見る。denpa のコンテナの中で実行すること。
 */

import { Database } from 'bun:sqlite';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';

const DB = process.env.DENPA_DB ?? '/app/data/denpa.db';
const RECORDED = process.env.RECORDED_DIR ?? '/app/recorded';
const LIBRARY = process.env.LIBRARY_DIR ?? '/library';

/** 生TSとして扱う拡張子 (src/lib/source.ts と同じ) */
const RAW_TS = ['.ts', '.m2ts', '.mts', '.m2t'];

const apply = process.argv.includes('--apply');
if (!existsSync(DB)) {
    console.error(`DBが見当たりません: ${DB} (denpa のコンテナの中で実行してください)`);
    process.exit(1);
}
const db = new Database(DB);

function log(message: string): void {
    console.log(message);
}

// --- ルールのジャンル -------------------------------------------------------

/**
 * ジャンル指定を denpa の書き方に揃える。
 *
 * denpa は文字列で `"7"`(大分類だけ)と `"7-0"`(中分類まで)を持つ。
 * EPGStation の `{genre, subGenre}` がそのまま入っていたり、引けない値が
 * 混ざっていたりすると、画面のジャンル欄がそれを名前に直せない。
 */
function normalizeGenres(raw: unknown): string[] | null {
    if (!Array.isArray(raw)) return null;
    const values: string[] = [];
    for (const item of raw) {
        if (typeof item === 'number' && Number.isInteger(item)) {
            values.push(String(item));
            continue;
        }
        if (typeof item === 'string' && /^\d+(-\d+)?$/.test(item)) {
            values.push(item);
            continue;
        }
        if (item !== null && typeof item === 'object') {
            const { genre, subGenre } = item as { genre?: unknown; subGenre?: unknown };
            if (typeof genre === 'number' && Number.isInteger(genre)) {
                values.push(
                    typeof subGenre === 'number' && Number.isInteger(subGenre)
                        ? `${genre}-${subGenre}`
                        : String(genre),
                );
            }
        }
        // 引ける形にならないものは落とす。残すと画面で読めない値が並ぶ
    }
    return values;
}

function repairGenres(): void {
    const rules = db.query('SELECT id, name, genres FROM rules WHERE genres IS NOT NULL').all() as {
        id: number;
        name: string;
        genres: string;
    }[];

    let changed = 0;
    for (const rule of rules) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(rule.genres);
        } catch {
            parsed = null;
        }
        const values = normalizeGenres(parsed);
        const next = values === null || values.length === 0 ? null : JSON.stringify(values);
        if (next === rule.genres) continue;

        changed++;
        log(`  ルール#${rule.id} ${rule.name}: ${rule.genres} -> ${next ?? 'NULL (全ジャンル)'}`);
        if (apply) db.query('UPDATE rules SET genres = ? WHERE id = ?').run(next, rule.id);
    }
    log(changed === 0 ? 'ジャンル: 直すものはありません' : `ジャンル: ${changed} 件`);
}

// --- 保存先に入ってしまった生TS ---------------------------------------------

/** 保存先に置いたときのお供。動画と一緒に片付ける */
function sidecars(path: string): string[] {
    const base = path.slice(0, -extname(path).length);
    return [`${base}.nfo`, `${base}-thumb.jpg`];
}

/** 空になった置き場のフォルダを畳む。保存先の外へは出ない */
function pruneEmptyDirs(from: string): void {
    let dir = dirname(from);
    while (relative(LIBRARY, dir) !== '' && !relative(LIBRARY, dir).startsWith('..')) {
        try {
            if (readdirSync(dir).length > 0) return;
            rmdirSync(dir);
        } catch {
            return;
        }
        dir = dirname(dir);
    }
}

function move(from: string, to: string): void {
    try {
        renameSync(from, to);
    } catch {
        // PVCをまたぐと rename は使えない
        copyFileSync(from, to);
        unlinkSync(from);
    }
}

function repairRawTs(): void {
    const recordings = db
        .query(
            `SELECT id, name, library_path FROM recordings
             WHERE library_path IS NOT NULL AND ts_path IS NULL AND deleted_at IS NULL`,
        )
        .all() as { id: number; name: string; library_path: string }[];

    let moved = 0;
    for (const recording of recordings) {
        const from = recording.library_path;
        if (!RAW_TS.includes(extname(from).toLowerCase())) continue;
        if (!existsSync(from)) {
            log(`  #${recording.id} ${recording.name}: ${from} が見当たりません (行だけ直します)`);
            if (apply) {
                db.query('UPDATE recordings SET library_path = NULL WHERE id = ?').run(recording.id);
            }
            continue;
        }

        // 名前は変えない。作業領域は人が見るところではないので平置きで足りる
        let to = join(RECORDED, basename(from));
        if (existsSync(to)) to = join(RECORDED, `${recording.id}-${basename(from)}`);

        moved++;
        log(`  #${recording.id} ${recording.name}: ${from} -> ${to}`);
        if (!apply) continue;

        mkdirSync(RECORDED, { recursive: true });
        move(from, to);
        for (const sidecar of sidecars(from)) {
            if (existsSync(sidecar)) unlinkSync(sidecar);
        }
        pruneEmptyDirs(from);
        db.query(
            'UPDATE recordings SET ts_path = ?, library_path = NULL, ts_size = ?, updated_at = ? WHERE id = ?',
        ).run(to, statSync(to).size, Date.now(), recording.id);
    }
    log(moved === 0 ? '生TS: 動かすものはありません' : `生TS: ${moved} 件`);
}

log(apply ? '=== 実行します ===' : '=== 下見です (直すには --apply) ===');
log(`DB: ${DB}`);
log(`生TSの置き場: ${RECORDED} / 保存先: ${LIBRARY}`);
repairGenres();
repairRawTs();
db.close();
