import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';
import { ADDED_COLUMNS, RECORDING_STATE, SCHEMA } from './schema';

/**
 * SQLite への接続。
 *
 * 最初に使われるまで開かない。import しただけでディレクトリを掘ってDBを作ると、
 * 引数の組み立てなど「DBに触らないはずの関数」を単体テストするだけで書き込み権限が
 * 要るようになってしまう(実際、CIで /app を掘ろうとして落ちた)。
 */
let instance: Database | null = null;

export function database(): Database {
    if (instance !== null) return instance;

    mkdirSync(dirname(config.dbPath), { recursive: true });
    const db = new Database(config.dbPath, { create: true });

    // WAL でないと、録画中の書き込みとUIの読み取りが SQLITE_BUSY で衝突する
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
    addMissingColumns(db);
    dropStoredState(db);

    instance = db;
    return instance;
}

/**
 * 後から足した列を、既にあるテーブルに補う。
 * 既にある列は飛ばすだけなので、何度実行しても同じ結果になる。
 */
export function addMissingColumns(db: Database): void {
    for (const { table, column, definition } of ADDED_COLUMNS) {
        const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (columns.length === 0) continue; // まだテーブルが無いなら SCHEMA 側で作られる
        if (columns.some((c) => c.name === column)) continue;
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`[db] ${table}.${column} を追加しました`);
    }
}

/** その列が「値を入れられる普通の列」か。生成列なら hidden が 2 か 3 になる */
function storedColumn(db: Database, table: string, column: string): boolean {
    const columns = db.query(`PRAGMA table_xinfo(${table})`).all() as { name: string; hidden: number }[];
    return columns.some((c) => c.name === column && c.hidden === 0);
}

/**
 * 状態の文字列で持っていたものを、事実から決まるものに移し替える。
 *
 * 新しく作るDBは SCHEMA が最初から生成列で作るので、ここは既にあるDB専用。
 * 何度流しても同じ結果になるように、移し終わっていれば何もしない。
 *
 * 順番に意味がある。
 * 1. 何が録り終わっていたのかを `finished_at` へ写す (落としてからでは分からない)
 * 2. エンコードの失敗で `recordings.error` に入っていた文言を消す。
 *    残すと生成列がその録画を丸ごと「失敗」と読む (理由は encode_jobs 側にある)
 * 3. 索引を落とす。列に索引が付いていると SQLite は DROP COLUMN を断る
 * 4. 列を入れ替えて索引を張り直す
 */
export function dropStoredState(db: Database): void {
    const recordings = db.query('PRAGMA table_info(recordings)').all() as { name: string }[];
    if (recordings.length === 0) return;

    if (storedColumn(db, 'recordings', 'state')) {
        db.exec(`UPDATE recordings SET finished_at = COALESCE(finished_at, updated_at, created_at)
                 WHERE state != 'recording'`);
        // エンコードで落ちたときに書かれていた文言。録画そのものは無事なので消す
        db.exec(`UPDATE recordings SET error = NULL WHERE error = 'エンコードに失敗しました'`);
        db.exec('DROP INDEX IF EXISTS recordings_state');
        db.exec('ALTER TABLE recordings DROP COLUMN state');
        db.exec(
            `ALTER TABLE recordings ADD COLUMN state TEXT GENERATED ALWAYS AS (${RECORDING_STATE}) VIRTUAL`,
        );
        db.exec('CREATE INDEX IF NOT EXISTS recordings_state ON recordings (state)');
        console.log('[db] recordings.state を生成列にしました');
    }

    /*
     * 予約側は録り始めたかどうかだけ残す。'recording'/'done'/'failed' は
     * 録画の行を見れば分かるので、予約の状態としては持たない
     */
    const started = db
        .query(
            `UPDATE reservations SET started_at = COALESCE(started_at, updated_at, created_at)
             WHERE started_at IS NULL AND state IN ('recording', 'done', 'failed')`,
        )
        .run().changes;
    if (started > 0) {
        db.exec(`UPDATE reservations SET state = 'scheduled' WHERE state IN ('recording', 'done', 'failed')`);
        console.log(`[db] 予約 ${started} 件の状態を録り始めた時刻に移しました`);
    }
}

export function now(): number {
    return Date.now();
}

/**
 * 1行だけ取る。
 *
 * bun:sqlite の `.get()` は該当行が無いとき `undefined` ではなく `null` を返すので、
 * `=== undefined` で書くと素通りして「null のプロパティを読む」で落ちる。
 * ここで undefined に正規化しておき、呼び出し側は普通の省略可能値として扱えるようにする。
 * `db.query` を使うのは、同じSQLの prepared statement をbun側で使い回させるため。
 */
export function queryOne<T>(sql: string, ...params: SQLQueryBindings[]): T | undefined {
    return (
        (database()
            .query(sql)
            .get(...params) as T | null) ?? undefined
    );
}

export function queryAll<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return database()
        .query(sql)
        .all(...params) as T[];
}
