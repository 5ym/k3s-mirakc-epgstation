import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { addMissingColumns, dropStoredState } from './db';
import { ADDED_COLUMNS, SCHEMA } from './schema';

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

/** 状態を文字列で持っていた頃のDB。移し替えの出発点 */
function oldShaped(): Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE recordings (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, ts_path TEXT, library_path TEXT,
        state TEXT NOT NULL, error TEXT, deleted_at INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE INDEX recordings_state ON recordings (state);
    CREATE TABLE reservations (
        id INTEGER PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)`);
    return db;
}

function stateOf(db: Database, id: number): string {
    return (db.query('SELECT state FROM recordings WHERE id = ?').get(id) as { state: string }).state;
}

describe('状態を持つのをやめる', () => {
    test('録り終えていたものは録り終えた時刻に移る', () => {
        const db = oldShaped();
        db.exec(`INSERT INTO recordings (id, name, state, library_path, created_at, updated_at)
                 VALUES (1, '録り終えた', 'available', '/library/a.mkv', 10, 20),
                        (2, '録画中', 'recording', NULL, 10, 20)`);

        addMissingColumns(db);
        dropStoredState(db);

        // 録り終えた時刻から状態が決まる。録画中のものは埋めない
        expect(db.query('SELECT finished_at FROM recordings WHERE id = 1').get()).toEqual({
            finished_at: 20,
        });
        expect(stateOf(db, 1)).toBe('available');
        expect(stateOf(db, 2)).toBe('recording');
    });

    test('エンコードで落ちただけの録画は失敗のまま残さない', () => {
        /*
         * 落ちたのは焼き直しのほうで、生TSは無事。録画そのものを失敗にしていたので、
         * 中身のあるTSを持っているのに再生もダウンロードもできなくなっていた。
         * 理由は encode_jobs 側に残っている
         */
        const db = oldShaped();
        db.exec(`INSERT INTO recordings (id, name, state, error, ts_path, created_at, updated_at)
                 VALUES (1, 'エンコード失敗', 'failed', 'エンコードに失敗しました', '/rec/a.ts', 10, 20)`);

        addMissingColumns(db);
        dropStoredState(db);

        expect(stateOf(db, 1)).toBe('recorded');
        expect(db.query('SELECT error FROM recordings WHERE id = 1').get()).toEqual({ error: null });
    });

    test('録画そのものの失敗は残る', () => {
        const db = oldShaped();
        db.exec(`INSERT INTO recordings (id, name, state, error, created_at, updated_at)
                 VALUES (1, '録画失敗', 'failed', 'ストリームから1バイトも受信できませんでした', 10, 20)`);

        addMissingColumns(db);
        dropStoredState(db);

        expect(stateOf(db, 1)).toBe('failed');
    });

    test('消したものは削除済みとして読める', () => {
        const db = oldShaped();
        db.exec(`INSERT INTO recordings (id, name, state, error, deleted_at, created_at, updated_at)
                 VALUES (1, '消した', 'available', '手動削除', 99, 10, 20)`);

        addMissingColumns(db);
        dropStoredState(db);

        // 削除の理由も error に入るが、消したことのほうが先に立つ
        expect(stateOf(db, 1)).toBe('deleted');
    });

    test('状態には書き込めない', () => {
        const db = oldShaped();
        db.exec(`INSERT INTO recordings (id, name, state, created_at, updated_at)
                 VALUES (1, '録画中', 'recording', 10, 20)`);
        addMissingColumns(db);
        dropStoredState(db);

        // 生成列なので、書き写して食い違わせることが原理的にできない
        expect(() => db.exec(`UPDATE recordings SET state = 'available' WHERE id = 1`)).toThrow();
    });

    test('予約の録り始めからの状態は時刻に移る', () => {
        const db = oldShaped();
        db.exec(`INSERT INTO reservations (id, state, created_at, updated_at)
                 VALUES (1, 'done', 10, 20), (2, 'recording', 10, 30),
                        (3, 'canceled', 10, 40), (4, 'scheduled', 10, 50)`);

        addMissingColumns(db);
        dropStoredState(db);

        const rows = db.query('SELECT id, state, started_at FROM reservations ORDER BY id').all();
        expect(rows).toEqual([
            { id: 1, state: 'scheduled', started_at: 20 },
            { id: 2, state: 'scheduled', started_at: 30 },
            // 録り始めていないものはそのまま
            { id: 3, state: 'canceled', started_at: null },
            { id: 4, state: 'scheduled', started_at: null },
        ]);
    });

    test('何度実行しても同じ', () => {
        const db = oldShaped();
        db.exec(`INSERT INTO recordings (id, name, state, library_path, created_at, updated_at)
                 VALUES (1, '録り終えた', 'available', '/library/a.mkv', 10, 20)`);
        addMissingColumns(db);
        dropStoredState(db);
        expect(() => dropStoredState(db)).not.toThrow();
        expect(stateOf(db, 1)).toBe('available');
    });

    /**
     * ルール 2 / 手動 3 は mirakc の頃の値を引きずっていた。比べる相手は
     * 予約どうしだけなので、ルール 1 / 手動 2 から数え直す
     */
    test('優先度を1つ下げる。順位はそのまま', () => {
        const db = new Database(':memory:');
        db.exec(SCHEMA);
        addMissingColumns(db);
        db.exec(`INSERT INTO rules (id, name, priority, created_at)
                 VALUES (1, '手で上げたもの', 5, 0), (2, 'ふつう', 2, 0), (3, 'いちばん下', 0, 0)`);
        db.exec(`INSERT INTO reservations (id, program_id, service_id, name, start_at, end_at,
                                           priority, created_at, updated_at)
                 VALUES (1, 10, 1, '手動', 0, 1, 3, 0, 0), (2, 11, 1, 'ルール由来', 0, 1, 2, 0, 0)`);

        dropStoredState(db);

        // 一律に1つ下げる。0 より下へは動かさない
        expect(db.query('SELECT id, priority FROM rules ORDER BY id').all()).toEqual([
            { id: 1, priority: 4 },
            { id: 2, priority: 1 },
            { id: 3, priority: 0 },
        ]);
        expect(db.query('SELECT id, priority FROM reservations ORDER BY id').all()).toEqual([
            { id: 1, priority: 2 },
            { id: 2, priority: 1 },
        ]);

        // 二度目は動かさない (印を user_version に持つ)
        dropStoredState(db);
        expect(db.query('SELECT priority FROM rules WHERE id = 2').get()).toEqual({ priority: 1 });
    });

    test('新しく作ったDBには何もしない', () => {
        const db = new Database(':memory:');
        db.exec(SCHEMA);
        addMissingColumns(db);
        expect(() => dropStoredState(db)).not.toThrow();
        // SCHEMA が最初から生成列で作っている
        db.exec(`INSERT INTO recordings (service_id, name, start_at, end_at, created_at, updated_at)
                 VALUES (1, '録画中', 0, 1, 10, 20)`);
        expect(stateOf(db, 1)).toBe('recording');
    });
});
