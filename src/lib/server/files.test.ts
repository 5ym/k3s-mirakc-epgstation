import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 古い履歴の片付け。
 *
 * 本物の pruneHistory を動かす。DBの置き場は一時ファイルへ向ける。
 *
 * 環境変数ではなく設定そのものを書き換えている。環境変数は config の
 * 読み込み時に1度だけ見られるので、同じプロセスで走る別のテストが先に
 * config を読んでいると効かない (bun test はファイルをまたいでモジュールを使い回す)。
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-files-')), 'denpa.db');
config.historyRetention = 14 * 24 * 60 * 60 * 1000;

const { database } = await import('./db');
const { pruneHistory, reconcile } = await import('./files');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function seed(): void {
    const db = database();
    db.exec('DELETE FROM reservations; DELETE FROM recordings; DELETE FROM encode_jobs');

    /*
     * 「終わった予約」は取り消し・録り逃しか、録り始めたもの (started_at が入る)。
     * 予約の行に 'done' や 'failed' は入らない — 顛末は録画の行が持っている
     */
    const reservation = db.prepare(
        `INSERT INTO reservations (id, program_id, service_id, name, start_at, end_at, state, started_at, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    );
    reservation.run(1, 1, '古い完了', now - 30 * DAY, now - 30 * DAY, 'scheduled', now - 30 * DAY, now, now);
    reservation.run(2, 2, '古い取り消し', now - 30 * DAY, now - 30 * DAY, 'canceled', null, now, now);
    reservation.run(3, 3, 'これから', now + DAY, now + DAY, 'scheduled', null, now, now);
    reservation.run(4, 4, '最近の完了', now - DAY, now - DAY, 'scheduled', now - DAY, now, now);

    // state は生成列なので入れられない。録り終えた時刻と保存先で「視聴可能」になる
    const recording = db.prepare(
        `INSERT INTO recordings (id, service_id, name, start_at, end_at, finished_at, library_path, deleted_at, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, '/library/x.mkv', ?, ?, ?)`,
    );
    recording.run(
        1,
        '古い削除済み',
        now - 30 * DAY,
        now - 30 * DAY,
        now - 30 * DAY,
        now - 30 * DAY,
        now,
        now,
    );
    recording.run(2, '最近の削除済み', now - DAY, now - DAY, now - DAY, now - DAY, now, now);
    recording.run(3, '残っている録画', now - 30 * DAY, now - 30 * DAY, now - 30 * DAY, null, now, now);

    const job = db.prepare(
        `INSERT INTO encode_jobs (id, recording_id, state, created_at, finished_at) VALUES (?, ?, ?, ?, ?)`,
    );
    // 消える録画にぶら下がっているもの
    job.run(1, 1, 'done', now, now);
    // 残る録画の、古い失敗と新しい成功。古いほうだけ消えて、最新は残る
    job.run(2, 3, 'failed', now - 30 * DAY, now - 30 * DAY);
    job.run(3, 3, 'done', now - 30 * DAY, now - 30 * DAY);
}

const ids = (table: string) =>
    (database().query(`SELECT id FROM ${table} ORDER BY id`).all() as { id: number }[]).map((row) => row.id);

describe('古い履歴の片付け', () => {
    test('2週間より古い「終わったもの」だけ消える', () => {
        seed();
        expect(pruneHistory()).toEqual({ reservations: 2, recordings: 1, jobs: 1 });
        // 残るのは「これから」と最近のもの
        expect(ids('reservations')).toEqual([3, 4]);
        // ファイルが残っている録画は、古くても消さない
        expect(ids('recordings')).toEqual([2, 3]);
    });

    test('録画の行と一緒にエンコードの記録も消える', () => {
        seed();
        pruneHistory();
        // 1 は録画ごと消えた。2 は古い失敗なので消える。
        // 3 はその録画の最新なので、古くても残す (一覧の状態表示がこれを見ている)
        expect(ids('encode_jobs')).toEqual([3]);
    });

    test('何度やっても同じ', () => {
        seed();
        pruneHistory();
        expect(pruneHistory()).toEqual({ reservations: 0, recordings: 0, jobs: 0 });
    });
});

/**
 * 実体との照合。**両方向を見る。**
 *
 * 行はあるが実体が無いものは削除済みに倒す。逆に、動画が消えたあとに残った
 * 付き添い (索引・NFO・サムネイル) は片付ける。**動画そのものには触らない** —
 * 手で置いたものかもしれないので、数えるだけ。
 */
describe('実体との照合', () => {
    /** 置き場を作り直して、そこに置いたファイルの一覧を返す */
    function files(): string[] {
        return readdirSync(config.recordedDir).sort();
    }

    function put(root: string, name: string): string {
        const path = join(root, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'x');
        return path;
    }

    function fresh(): void {
        const root = mkdtempSync(join(tmpdir(), 'denpa-recon-'));
        config.recordedDir = join(root, 'recorded');
        config.libraryDir = join(root, 'library');
        mkdirSync(config.recordedDir, { recursive: true });
        mkdirSync(config.libraryDir, { recursive: true });
        database().exec('DELETE FROM recordings');
    }

    /*
     * chapter_exe と logoframe は TS を直接読むのに dtvindex の索引を作り、
     * `<入力>.dtvi` に置く。生TSを残さない設定だと TS が消えたあとも索引だけが
     * 居座り、録るたびに3MBずつ積もる (実機で9本 22MB)
     */
    test('連れ合いの消えた索引を片付ける', () => {
        fresh();
        put(config.recordedDir, 'のこる.m2ts');
        put(config.recordedDir, 'のこる.m2ts.dtvi');
        put(config.recordedDir, 'きえた.m2ts.dtvi');
        put(config.recordedDir, 'きえた.m2ts.jls.chapterexe.txt');

        expect(reconcile().swept).toBe(2);
        expect(files()).toEqual(['のこる.m2ts', 'のこる.m2ts.dtvi']);
    });

    test('動画の残っている NFO とサムネイルは残す', () => {
        fresh();
        put(config.libraryDir, '番組/Season 2026/番組 - 1.mkv');
        put(config.libraryDir, '番組/Season 2026/番組 - 1.nfo');
        put(config.libraryDir, '番組/Season 2026/番組 - 1-thumb.jpg');
        put(config.libraryDir, '番組/tvshow.nfo');

        expect(reconcile().swept).toBe(0);
    });

    test('動画の消えた NFO とサムネイルは、シリーズごと片付ける', () => {
        fresh();
        put(config.libraryDir, '番組/Season 2026/番組 - 1.nfo');
        put(config.libraryDir, '番組/Season 2026/番組 - 1-thumb.jpg');
        put(config.libraryDir, '番組/tvshow.nfo');

        expect(reconcile().swept).toBe(3);
        expect(existsSync(join(config.libraryDir, '番組'))).toBe(false);
    });

    test('DBに無い動画は数えるだけ。手で置いたものかもしれない', () => {
        fresh();
        put(config.libraryDir, '手で置いた/Season 2026/手で置いた - 1.mkv');

        const result = reconcile();
        expect(result.strays).toBe(1);
        expect(result.swept).toBe(0);
        expect(existsSync(join(config.libraryDir, '手で置いた/Season 2026/手で置いた - 1.mkv'))).toBe(true);
    });
});
