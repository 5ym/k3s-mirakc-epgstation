/**
 * EPGStation の録画とルールを denpa に引き継ぐ。
 *
 *   bun scripts/migrate-epgstation.ts              # 何が起きるか出すだけ
 *   bun scripts/migrate-epgstation.ts --apply      # 実際に取り込む
 *   bun scripts/migrate-epgstation.ts --apply --move   # コピーではなく移動する
 *
 * EPGStation の MariaDB を読み、録画ファイルを denpa のライブラリの並びに置き直して
 * `recordings` に登録する。Jellyfin 向けの .nfo とサムネイルもそこで作る。
 *
 * ファイルは既定でコピーする。元のPVCを消すまで EPGStation 側もそのまま動くので、
 * 取り込みが済んで中身を確認してから消せる。容量が無いときは --move を使う。
 *
 * 何度実行しても同じ結果になる。取り込み済みのものは EPGStation 側のIDで判別して飛ばす。
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../src/lib/server/config';
import { database, now, queryOne } from '../src/lib/server/db';
import { libraryPath } from '../src/lib/server/library';
import { writeNfo, writeThumbnail } from '../src/lib/server/metadata';
import { parseTitle, toHalfWidth } from '../src/lib/server/title';
import type { Recording } from '../src/lib/types';

const apply = process.argv.includes('--apply');
const move = process.argv.includes('--move');

const env = (key: string, fallback: string) => process.env[key] ?? fallback;
const DB = {
    host: env('EPGSTATION_DB_HOST', 'db'),
    port: Number(env('EPGSTATION_DB_PORT', '3306')),
    user: env('EPGSTATION_DB_USER', 'root'),
    password: env('EPGSTATION_DB_PASSWORD', 'epgstation'),
    database: env('EPGSTATION_DB_NAME', 'epgstation'),
};
/** EPGStation のPVCを denpa 側にマウントした場所 */
const SOURCE_ROOT = env('EPGSTATION_RECORDED_DIR', '/epgstation-recorded');

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
        join(SOURCE_ROOT, filePath),
        filePath.startsWith('/') ? filePath : join(SOURCE_ROOT, filePath.replace(/^\.?\//, '')),
        join(SOURCE_ROOT, filePath.split('/').pop() ?? ''),
    ];
    return candidates.find((path) => existsSync(path)) ?? null;
}

async function main(): Promise<void> {
    const connection = await mysql.createConnection(DB);

    // EPGStation v2 のテーブル構成。エンコード済みがあればそちらを優先して取る
    const [rows] = await connection.query<(Row & mysql.RowDataPacket)[]>(
        `SELECT r.id, r.name, r.description, r.startAt, r.endAt,
                r.channelId, c.name AS channelName, c.serviceId, c.networkId,
                v.filePath, v.type AS fileType, v.size AS fileSize
         FROM recorded r
         LEFT JOIN channel c ON c.id = r.channelId
         LEFT JOIN video_file v ON v.recordedId = r.id
         WHERE r.isRecording = 0
         ORDER BY r.startAt`,
    );
    await connection.end();

    // 1つの録画に生TSとエンコード済みが両方あることがある。エンコード済みを優先
    const best = new Map<number, Row>();
    for (const row of rows) {
        const current = best.get(row.id);
        if (current === undefined || (current.fileType !== 'encoded' && row.fileType === 'encoded')) {
            best.set(row.id, row);
        }
    }

    let imported = 0;
    let skipped = 0;
    let missing = 0;

    for (const row of best.values()) {
        // 取り込み済みは EPGStation 側のIDで判別する
        const already = queryOne<{ id: number }>(
            `SELECT id FROM recordings WHERE program_id = ? AND reservation_id IS NULL`,
            -row.id,
        );
        if (already !== undefined) {
            skipped++;
            continue;
        }

        if (row.filePath === null) {
            console.warn(`ファイルが無い: ${row.name}`);
            missing++;
            continue;
        }
        const from = sourcePath(row.filePath);
        if (from === null) {
            console.warn(`見つからない: ${row.filePath} (${row.name})`);
            missing++;
            continue;
        }

        const name = toHalfWidth(row.name);
        const parsed = parseTitle(name);
        const service = queryOne<{ id: number; name: string }>(
            'SELECT id, name FROM services WHERE network_id = ? AND service_id = ?',
            row.networkId,
            row.serviceId,
        );

        console.log(`${apply ? '取り込む' : '取り込む(予定)'}: ${name}  <- ${from}`);
        if (!apply) {
            imported++;
            continue;
        }

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
        if (move) {
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
        imported++;
    }

    console.log(
        `\n${apply ? '完了' : '(--apply を付けると実行します)'}: ` +
            `取り込み ${imported} 件 / 取り込み済み ${skipped} 件 / ファイル無し ${missing} 件`,
    );
    console.log(`ライブラリ: ${config.libraryDir}`);
}

await main();
