import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';
import { ADDED_COLUMNS, SCHEMA } from './schema';

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
