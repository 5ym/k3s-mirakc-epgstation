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

    /*
     * 「ロゴを当てられなかった」も持たない。CM検出の覚え書き (`cm_note`) に
     * ロゴを使えなかったことは必ず書いてあるので、そちらから読めばいい。
     *
     * 別に持っていた頃は、**後から条件を広げても古い録画に効かなかった**。
     * 「結果の100%がCM判定だったので捨てた」ときも位置を教えられるようにしたのに、
     * 既に録ってある分は 0 のまま残り、画面に出なかった (実機で2本)
     */
    if (recordings.some((c) => c.name === 'logo_missing')) {
        db.exec('ALTER TABLE recordings DROP COLUMN logo_missing');
        console.log('[db] recordings.logo_missing を落としました (cm_note から読みます)');
    }

    /*
     * **焼き方はルールに持たせない。**
     *
     * ルールの行にも「エンコードする / 生TSも残す / CMの扱い / コーデック」が
     * 入っていたが、予約を立てるところ (rules.ts) はそこを一度も読んでおらず、
     * **設定 (settings) のほうを見ていた**。編集画面に出ていただけの値で、
     * 設定を変えても直らないので、開くたびに古い値が並んでいた。
     *
     * `free_only` も同じ。無料放送だけにするかは全体設定で、ルールごとには持たない。
     */
    const rules = db.query('PRAGMA table_info(rules)').all() as { name: string }[];
    for (const column of ['encode', 'keep_original', 'cm_cut', 'codec', 'free_only']) {
        if (!rules.some((c) => c.name === column)) continue;
        db.exec(`ALTER TABLE rules DROP COLUMN ${column}`);
        console.log(`[db] rules.${column} を落としました (焼き方は設定で決めます)`);
    }

    shiftPriorities(db);
}

/**
 * 予約どうしの優先度を1つ下へずらす。**順位は変えない。**
 *
 * ルール 2 / 手動 3 で始まったのは、前に使っていた番号をそのまま持ってきたため。
 * 比べる相手は予約どうしだけなので、**ルール 1 / 手動 2** から数える。
 *
 * **全部を一律にずらす。** 既定だけ変えると、前からある行 (2) が新しい行 (1) より
 * 強いままになる。一律なら、手で付けた差もそのまま残る。0 より下へは動かさない。
 *
 * 1度だけ効かせたいので、印を `user_version` に持つ (行を数えて判断すると、
 * たまたま全部 1 のときに二度目が走る)。
 */
const PRIORITY_BASE_SHIFTED = 1;

function shiftPriorities(db: Database): void {
    const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version >= PRIORITY_BASE_SHIFTED) return;

    // 途中まで作ったDBを渡されることがある (移行のテスト)。無い表は触らない
    const tables = db.query('SELECT name FROM sqlite_master WHERE type = ?').all('table') as {
        name: string;
    }[];
    const has = (name: string) => tables.some((table) => table.name === name);
    if (!has('rules') || !has('reservations')) return;

    const rules = db.query('UPDATE rules SET priority = MAX(0, priority - 1)').run().changes;
    const reservations = db.query('UPDATE reservations SET priority = MAX(0, priority - 1)').run().changes;
    db.exec(`PRAGMA user_version = ${PRIORITY_BASE_SHIFTED}`);
    if (rules > 0 || reservations > 0) {
        console.log(`[db] 優先度を1つ下げました (ルール ${rules} 件 / 予約 ${reservations} 件)`);
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
