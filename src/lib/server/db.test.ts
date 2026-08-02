import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { addMissingColumns } from './db';
import { ADDED_COLUMNS } from './schema';

function columnsOf(db: Database, table: string): string[] {
    return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe('addMissingColumns', () => {
    test('古いテーブルに後から足した列を補う', () => {
        const db = new Database(':memory:');
        // 列を足す前の recordings 相当
        db.exec(`CREATE TABLE recordings (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);

        addMissingColumns(db);

        const columns = columnsOf(db, 'recordings');
        for (const added of ADDED_COLUMNS.filter((c) => c.table === 'recordings')) {
            expect(columns).toContain(added.column);
        }
    });

    test('既定値が入るので、既存の行も読める', () => {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE recordings (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
        db.exec(`INSERT INTO recordings (id, name) VALUES (1, '既存の録画')`);

        addMissingColumns(db);

        const row = db.query('SELECT * FROM recordings WHERE id = 1').get() as Record<string, unknown>;
        expect(row.codec).toBe('av1');
        expect(row.cm_cut).toBe('chapter');
        expect(row.acknowledged_at).toBeNull();
    });

    test('前からあるルールは、それまでと同じ範囲を探し続ける', () => {
        /*
         * 検索対象を選べるようにする前のルールは「番組名+概要」で当てていた。
         * 新しい既定 (番組名だけ) で埋めると、黙って当たらなくなるものが出る
         */
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE rules (id INTEGER PRIMARY KEY, keyword TEXT NOT NULL DEFAULT '')`);
        db.exec(`INSERT INTO rules (id, keyword) VALUES (1, '名探偵')`);

        addMissingColumns(db);

        const row = db.query('SELECT * FROM rules WHERE id = 1').get() as Record<string, unknown>;
        expect(row.search_fields).toBe('name,description');
    });

    test('何度実行しても壊れない', () => {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE services (id INTEGER PRIMARY KEY)`);
        addMissingColumns(db);
        addMissingColumns(db);
        expect(columnsOf(db, 'services').filter((c) => c === 'has_logo')).toHaveLength(1);
    });

    test('テーブルがまだ無ければ何もしない', () => {
        const db = new Database(':memory:');
        expect(() => addMissingColumns(db)).not.toThrow();
    });
});
