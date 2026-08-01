import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';
import { SCHEMA } from './schema';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });

// WAL でないと、録画中の書き込みとUIの読み取りが SQLITE_BUSY で衝突する
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');
db.exec(SCHEMA);

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
    return (db.query(sql).get(...params) as T | null) ?? undefined;
}

export function queryAll<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return db.query(sql).all(...params) as T[];
}
