import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 古い履歴の片付け。
 *
 * 本物の pruneHistory を動かす。DBの置き場は環境変数で決まるので、
 * **読み込む前に**一時ファイルへ向けておく。
 */
process.env.DENPA_DB = join(mkdtempSync(join(tmpdir(), 'denpa-files-')), 'denpa.db');
process.env.HISTORY_RETENTION = String(14 * 24 * 60 * 60 * 1000);

const { database } = await import('./db');
const { pruneHistory } = await import('./files');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function seed(): void {
    const db = database();
    db.exec('DELETE FROM reservations; DELETE FROM recordings; DELETE FROM encode_jobs');

    const reservation = db.prepare(
        `INSERT INTO reservations (id, program_id, service_id, name, start_at, end_at, state, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    );
    reservation.run(1, 1, '古い完了', now - 30 * DAY, now - 30 * DAY, 'done', now, now);
    reservation.run(2, 2, '古い取り消し', now - 30 * DAY, now - 30 * DAY, 'canceled', now, now);
    reservation.run(3, 3, 'これから', now + DAY, now + DAY, 'scheduled', now, now);
    reservation.run(4, 4, '最近の完了', now - DAY, now - DAY, 'done', now, now);

    const recording = db.prepare(
        `INSERT INTO recordings (id, service_id, name, start_at, end_at, state, deleted_at, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, 'available', ?, ?, ?)`,
    );
    recording.run(1, '古い削除済み', now - 30 * DAY, now - 30 * DAY, now - 30 * DAY, now, now);
    recording.run(2, '最近の削除済み', now - DAY, now - DAY, now - DAY, now, now);
    recording.run(3, '残っている録画', now - 30 * DAY, now - 30 * DAY, null, now, now);

    db.prepare(`INSERT INTO encode_jobs (id, recording_id, state, created_at) VALUES (1, 1, 'done', ?)`).run(
        now,
    );
}

const ids = (table: string) =>
    (database().query(`SELECT id FROM ${table} ORDER BY id`).all() as { id: number }[]).map((row) => row.id);

describe('古い履歴の片付け', () => {
    test('2週間より古い「終わったもの」だけ消える', () => {
        seed();
        expect(pruneHistory()).toEqual({ reservations: 2, recordings: 1 });
        // 残るのは「これから」と最近のもの
        expect(ids('reservations')).toEqual([3, 4]);
        // ファイルが残っている録画は、古くても消さない
        expect(ids('recordings')).toEqual([2, 3]);
    });

    test('録画の行と一緒にエンコードの記録も消える', () => {
        seed();
        pruneHistory();
        expect(ids('encode_jobs')).toEqual([]);
    });

    test('何度やっても同じ', () => {
        seed();
        pruneHistory();
        expect(pruneHistory()).toEqual({ reservations: 0, recordings: 0 });
    });
});
