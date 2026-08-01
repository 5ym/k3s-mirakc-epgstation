/**
 * EPGStation の録画を denpa に引き継ぐ。
 *
 * 数百GBのコピーになるので、リクエストの中では終わらない。開始だけ受けて
 * 裏で進め、進捗は {@link status} から読む。CLI(scripts/migrate-epgstation.ts)と
 * 設定画面のどちらからでも同じものを走らせる。
 *
 * ファイルは既定でコピーする。元のPVCを消すまで EPGStation 側もそのまま動くので、
 * 取り込みが済んで中身を確認してから消せる。容量が無いときは move を使う。
 *
 * 何度実行しても同じ結果になる。取り込み済みのものは EPGStation 側のIDで判別して飛ばす。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import mysql from 'mysql2/promise';
import type { Recording } from '$lib/types';
import { database, now, queryOne } from './db';
import { emit } from './events';
import { libraryPath } from './library';
import { writeNfo, writeThumbnail } from './metadata';
import { parseTitle, toHalfWidth } from './title';

const env = (key: string, fallback: string) => process.env[key] ?? fallback;

/** EPGStation の MariaDB。mysql2 は知らないキーを渡すと文句を言うので他と混ぜない */
const connection = {
    host: env('EPGSTATION_DB_HOST', 'db'),
    port: Number(env('EPGSTATION_DB_PORT', '3306')),
    user: env('EPGSTATION_DB_USER', 'root'),
    password: env('EPGSTATION_DB_PASSWORD', 'epgstation'),
    database: env('EPGSTATION_DB_NAME', 'epgstation'),
};

export const source = {
    host: connection.host,
    /** EPGStation のPVCを denpa 側にマウントした場所 */
    recordedDir: env('EPGSTATION_RECORDED_DIR', '/epgstation-recorded'),
};

/** 引き継ぎ元が見えているか。マウントしていなければ設定画面から実行させない */
export function available(): boolean {
    return existsSync(source.recordedDir);
}

export interface MigrateOptions {
    /** false なら何が起きるかを出すだけでファイルもDBも触らない */
    apply: boolean;
    /** コピーではなく移動する。元のPVCに空きが無いとき用 */
    move: boolean;
}

export interface MigrateStatus extends MigrateOptions {
    state: 'idle' | 'running' | 'done' | 'failed';
    /** 対象の総数。走り出すまでは 0 */
    total: number;
    imported: number;
    skipped: number;
    missing: number;
    /** いま扱っている録画の名前 */
    current: string | null;
    /** 直近の記録。全部残すと際限が無いので後ろから 200 件だけ持つ */
    log: string[];
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
}

const LOG_LIMIT = 200;

let status_: MigrateStatus = {
    state: 'idle',
    apply: false,
    move: false,
    total: 0,
    imported: 0,
    skipped: 0,
    missing: 0,
    current: null,
    log: [],
    error: null,
    startedAt: null,
    finishedAt: null,
};

export function status(): MigrateStatus {
    return { ...status_, log: [...status_.log] };
}

function record(message: string): void {
    status_.log.push(message);
    if (status_.log.length > LOG_LIMIT) status_.log.splice(0, status_.log.length - LOG_LIMIT);
}

interface Row {
    id: number;
    name: string;
    description: string | null;
    startAt: number;
    endAt: number;
    channelId: number | null;
    channelName: string | null;
    serviceId: number | null;
    networkId: number | null;
    filePath: string | null;
    fileType: string | null;
    fileSize: number | null;
}

/**
 * EPGStation が持つパスを、こちらから見えるパスに直す。
 * 相対パスで持っていることも絶対パスのこともあるので両方を見る。
 */
function sourcePath(filePath: string): string | null {
    const candidates = [
        join(source.recordedDir, filePath),
        filePath.startsWith('/') ? filePath : join(source.recordedDir, filePath.replace(/^\.?\//, '')),
        join(source.recordedDir, filePath.split('/').pop() ?? ''),
    ];
    return candidates.find((path) => existsSync(path)) ?? null;
}

async function fetchRows(): Promise<Row[]> {
    const db = await mysql.createConnection(connection);
    try {
        // EPGStation v2 のテーブル構成。エンコード済みがあればそちらを優先して取る
        const [rows] = await db.query<(Row & mysql.RowDataPacket)[]>(
            `SELECT r.id, r.name, r.description, r.startAt, r.endAt,
                    r.channelId, c.name AS channelName, c.serviceId, c.networkId,
                    v.filePath, v.type AS fileType, v.size AS fileSize
             FROM recorded r
             LEFT JOIN channel c ON c.id = r.channelId
             LEFT JOIN video_file v ON v.recordedId = r.id
             WHERE r.isRecording = 0
             ORDER BY r.startAt`,
        );
        // 1つの録画に生TSとエンコード済みが両方あることがある。エンコード済みを優先
        const best = new Map<number, Row>();
        for (const row of rows) {
            const current = best.get(row.id);
            if (current === undefined || (current.fileType !== 'encoded' && row.fileType === 'encoded')) {
                best.set(row.id, row);
            }
        }
        return [...best.values()];
    } finally {
        await db.end();
    }
}

/** 1件を取り込む。取り込めたかどうかを返す */
async function importOne(row: Row, options: MigrateOptions): Promise<'imported' | 'skipped' | 'missing'> {
    // 取り込み済みは EPGStation 側のIDで判別する
    const already = queryOne<{ id: number }>(
        `SELECT id FROM recordings WHERE program_id = ? AND reservation_id IS NULL`,
        -row.id,
    );
    if (already !== undefined) return 'skipped';

    if (row.filePath === null) {
        record(`ファイルが無い: ${row.name}`);
        return 'missing';
    }
    const from = sourcePath(row.filePath);
    if (from === null) {
        record(`見つからない: ${row.filePath} (${row.name})`);
        return 'missing';
    }

    const name = toHalfWidth(row.name);
    record(`${options.apply ? '取り込む' : '取り込む(予定)'}: ${name}`);
    if (!options.apply) return 'imported';

    const parsed = parseTitle(name);
    const service = queryOne<{ id: number; name: string }>(
        'SELECT id, name FROM services WHERE network_id = ? AND service_id = ?',
        row.networkId,
        row.serviceId,
    );

    const at = now();
    // program_id は EPGStation のIDの符号を反転して入れる。
    // denpa の番組IDと衝突せず、二重取り込みの判定にも使える
    const info = database()
        .prepare(
            `INSERT INTO recordings
                (reservation_id, program_id, service_id, service_name, name, series, subtitle,
                 description, start_at, end_at, state, created_at, updated_at)
             VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`,
        )
        .run(
            -row.id,
            service?.id ?? 0,
            service?.name ?? toHalfWidth(row.channelName ?? ''),
            name,
            parsed.series,
            parsed.subtitle,
            toHalfWidth(row.description ?? ''),
            Number(row.startAt),
            Number(row.endAt),
            at,
            at,
        );

    const id = Number(info.lastInsertRowid);
    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', id)!;
    const extension = from.slice(from.lastIndexOf('.'));
    const to = libraryPath(recording, extension === '' ? '.m2ts' : extension);

    mkdirSync(dirname(to), { recursive: true });
    if (options.move) {
        try {
            renameSync(from, to);
        } catch {
            // PVCをまたぐと rename は使えない
            copyFileSync(from, to);
            unlinkSync(from);
        }
    } else {
        copyFileSync(from, to);
    }

    database()
        .prepare('UPDATE recordings SET library_path = ?, ts_size = ?, updated_at = ? WHERE id = ?')
        .run(to, statSync(to).size, now(), id);

    const placed = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', id)!;
    writeNfo(placed, to);
    await writeThumbnail(to, (Number(row.endAt) - Number(row.startAt)) / 1000);
    return 'imported';
}

/**
 * 取り込みを走らせる。進捗は {@link status} に入る。
 *
 * 呼び出し側を待たせないので、CLI から使うときは返り値を await すること。
 */
export async function run(options: MigrateOptions): Promise<MigrateStatus> {
    status_ = {
        state: 'running',
        apply: options.apply,
        move: options.move,
        total: 0,
        imported: 0,
        skipped: 0,
        missing: 0,
        current: null,
        log: [],
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
    };
    emit('migrate');

    try {
        const rows = await fetchRows();
        status_.total = rows.length;
        record(`対象 ${rows.length} 件`);
        emit('migrate');

        for (const row of rows) {
            status_.current = toHalfWidth(row.name);
            const result = await importOne(row, options);
            status_[result]++;
            emit('migrate');
        }
        status_.current = null;
        status_.state = 'done';
    } catch (error) {
        status_.state = 'failed';
        status_.error = String(error);
        record(`失敗: ${status_.error}`);
    }
    status_.finishedAt = Date.now();
    emit('migrate');
    return status();
}

/**
 * 設定画面から呼ぶ入口。走り出したことだけ返し、終わるのは待たない。
 * 二重に走ると同じファイルを2つのコピーが掴むので、走っている間は断る。
 */
export function start(options: MigrateOptions): { started: boolean; message: string } {
    if (status_.state === 'running') {
        return { started: false, message: 'すでに実行中です' };
    }
    if (!available()) {
        return {
            started: false,
            message: `引き継ぎ元 ${source.recordedDir} が見えません。EPGStation のPVCをマウントしてください`,
        };
    }
    void run(options);
    return { started: true, message: options.apply ? '取り込みを開始しました' : '下見を開始しました' };
}
