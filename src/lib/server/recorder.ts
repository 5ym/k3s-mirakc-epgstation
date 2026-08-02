import { once } from 'node:events';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Program, Recording, Reservation, Service } from '../types';
import { config } from './config';
import { database, now, queryOne } from './db';
import { enqueue } from './encoder';
import { emit } from './events';
import { moveFile } from './fsx';
import { libraryPath, recordedPath } from './library';
import { watch as watchLogo } from './logo';
import { writeNfo, writeThumbnail } from './metadata';
import { openServiceStream } from './mirakc';
import { chunks } from './stream';
import { parseTitle } from './title';
import { notify } from './webhook';

/** 録画中のストリームを止めるための口。プロセス内にしか無いので再起動で失われる(起動時に失敗扱いにする) */
const active = new Map<number, AbortController>();

export function activeRecordingIds(): number[] {
    return [...active.keys()];
}

export function stopRecording(recordingId: number): void {
    active.get(recordingId)?.abort();
}

/** 通知用に録画の要点をまとめる */
function summary(recording: Recording) {
    return {
        id: recording.id,
        name: recording.name,
        service: recording.service_name,
        startAt: recording.start_at,
        endAt: recording.end_at,
    };
}

function fail(recordingId: number, error: string): void {
    database()
        .prepare(`UPDATE recordings SET state = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .run(error, now(), recordingId);
    const rec = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', recordingId);
    if (rec !== undefined) {
        notify({
            event: 'recording.failed',
            text: `録画に失敗しました: ${rec.name} (${rec.service_name})`,
            recording: summary(rec),
            error,
        });
    }
    if (rec?.reservation_id != null) {
        database()
            .prepare(`UPDATE reservations SET state = 'failed', updated_at = ? WHERE id = ?`)
            .run(now(), rec.reservation_id);
    }
}

export function createRecording(reservation: Reservation): Recording {
    const service = queryOne<Service>('SELECT * FROM services WHERE id = ?', reservation.service_id);
    const program = queryOne<Program>('SELECT * FROM programs WHERE id = ?', reservation.program_id);
    const parsed = parseTitle(reservation.name);
    const at = now();

    const info = database()
        .prepare(
            `INSERT INTO recordings
                (reservation_id, program_id, service_id, service_name, name, series, subtitle,
                 description, start_at, end_at, audio_type, state, keep_original, cm_cut, codec,
                 created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?, ?, ?, ?)`,
        )
        .run(
            reservation.id,
            reservation.program_id,
            reservation.service_id,
            service?.name ?? '',
            reservation.name,
            parsed.series,
            parsed.subtitle,
            reservation.description,
            reservation.start_at,
            reservation.end_at,
            program?.audio_type ?? null,
            reservation.keep_original,
            reservation.cm_cut,
            reservation.codec,
            at,
            at,
        );

    const id = Number(info.lastInsertRowid);
    // ファイル名は録画IDを含めるため、行を作ってからでないと決まらない
    const path = recordedPath({
        id,
        series: parsed.series,
        subtitle: parsed.subtitle,
        start_at: reservation.start_at,
    });
    database().prepare('UPDATE recordings SET ts_path = ? WHERE id = ?').run(path, id);

    return queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', id)!;
}

/**
 * 予約を録画に移す。ストリームの読み出しは待たずにバックグラウンドで走らせ、
 * 呼び出し側(スケジューラのtick)を塞がないようにする。
 */
export async function startRecording(reservation: Reservation): Promise<Recording> {
    const recording = createRecording(reservation);
    emit('recordings');
    const controller = new AbortController();
    active.set(recording.id, controller);

    notify({
        event: 'recording.started',
        text: `録画を開始しました: ${recording.name} (${recording.service_name})`,
        recording: summary(recording),
    });

    void pump(recording, controller).catch((error) => {
        active.delete(recording.id);
        fail(recording.id, String(error));
    });

    return recording;
}

/**
 * チューナーが空くのを少し待つ。
 *
 * 前の番組の録画が終わってから mirakc がチューナーを手放すまでには間があり、
 * 直後に始まる番組がそこで弾かれることがある。番組の頭を数秒落としてでも
 * 録れたほうがいいので、すぐには諦めない。
 */
const OPEN_RETRIES = 5;
const OPEN_RETRY_WAIT = 2000;

async function openWithRetry(serviceId: number, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    let last: unknown;
    for (let attempt = 0; attempt < OPEN_RETRIES; attempt++) {
        if (signal.aborted) throw new Error('録画が中止されました');
        try {
            return await openServiceStream(serviceId, signal);
        } catch (error) {
            last = error;
            if (attempt < OPEN_RETRIES - 1) {
                await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_WAIT));
            }
        }
    }
    throw new Error(`チューナーを ${OPEN_RETRIES} 回試して掴めませんでした: ${last}`);
}

/** 実際に録れた長さを足す。再開したぶんも合算するので加算にする */
function addDuration(recordingId: number, ms: number): void {
    if (ms <= 0) return;
    database()
        .prepare('UPDATE recordings SET duration_ms = COALESCE(duration_ms, 0) + ? WHERE id = ?')
        .run(ms, recordingId);
}

async function pump(recording: Recording, controller: AbortController): Promise<void> {
    const path = recording.ts_path!;
    mkdirSync(dirname(path), { recursive: true });

    let written = 0;
    try {
        const stream = await openWithRetry(recording.service_id, controller.signal);
        // 追記で開く。再起動をまたいで録画を再開したときに、それまでの分を消さないため
        // (MPEG-TS は 188 バイトのパケットの並びなので、そのまま繋げても読める)
        const sink = createWriteStream(path, { flags: 'a' });
        // 実際に受け取っていた時間を測る。番組表の尺は予定でしかなく、
        // 途中で止めたときや掴むのに手間取ったときは実物と合わない。
        // 再開したときは足していく(ファイルも追記なので合計が実物になる)
        const from = Date.now();
        // mirakc はロゴを TS から集めないので、録画のついでに拾っておく。
        // 局ロゴのために別途チューナーを開かずに済む
        const collectLogo = watchLogo(recording.service_id);
        try {
            for await (const chunk of chunks(stream)) {
                written += chunk.byteLength;
                collectLogo(chunk);
                if (!sink.write(chunk)) await once(sink, 'drain');
            }
        } finally {
            addDuration(recording.id, Date.now() - from);
            await new Promise<void>((resolve, reject) => {
                sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
            });
        }
    } catch (error) {
        // 終了時刻に達して自分で abort した場合は正常終了。それ以外だけ失敗にする
        if (!controller.signal.aborted) {
            active.delete(recording.id);
            fail(recording.id, String(error));
            return;
        }
    } finally {
        active.delete(recording.id);
    }

    let size = written;
    try {
        size = statSync(path).size;
    } catch {
        // 統計が取れなくても書き込み量で代用する
    }

    if (size === 0) {
        fail(recording.id, 'ストリームから1バイトも受信できませんでした');
        return;
    }

    finish(recording.id, size);
}

/** 録画完了。エンコードするならキューに積み、しないならそのまま保存先に置く */
export function finish(recordingId: number, size: number): void {
    const at = now();
    database()
        .prepare(`UPDATE recordings SET state = 'recorded', ts_size = ?, updated_at = ? WHERE id = ?`)
        .run(size, at, recordingId);

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', recordingId)!;
    if (recording.reservation_id != null) {
        database()
            .prepare(`UPDATE reservations SET state = 'done', updated_at = ? WHERE id = ?`)
            .run(at, recording.reservation_id);
    }

    const reservation =
        recording.reservation_id == null
            ? undefined
            : queryOne<{ encode: number }>(
                  'SELECT encode FROM reservations WHERE id = ?',
                  recording.reservation_id,
              );

    emit('recordings');
    notify({
        event: 'recording.finished',
        text: `録画が終わりました: ${recording.name} (${recording.service_name})`,
        recording: summary(recording),
    });

    if (reservation === undefined || reservation.encode) {
        enqueue(recording.id);
        return;
    }

    // エンコードしない設定なら生TSをそのまま保存先へ移す
    const dest = libraryPath(recording, '.m2ts');
    moveFile(recording.ts_path!, dest);
    writeNfo(recording, dest);
    void writeThumbnail(dest, (recording.end_at - recording.start_at) / 1000);
    database()
        .prepare(
            `UPDATE recordings SET state = 'available', library_path = ?, ts_path = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(dest, now(), recording.id);
}

/**
 * プロセスが落ちた時点で録画中だった行を拾い直す。
 *
 * AbortController はメモリ上にしか無いので、再起動すると録画は止まったままになる。
 * まだ放送中のものは録り直しに行く。生TSは追記で開くので、落ちるまでに録れていた分は
 * そのまま残り、抜けるのは止まっていた間だけになる。
 * 放送が終わってしまったものは、もう取り返せないので失敗に倒す。
 */
export function recoverOrphanedRecordings(): { resumed: number; failed: number } {
    const orphans = database()
        .prepare(`SELECT * FROM recordings WHERE state = 'recording'`)
        .all() as Recording[];

    let resumed = 0;
    let failed = 0;
    const at = now();
    for (const orphan of orphans) {
        if (orphan.ts_path === null || orphan.end_at + config.endMargin <= at) {
            fail(orphan.id, 'アプリの再起動により録画が中断されました');
            failed++;
            continue;
        }

        const controller = new AbortController();
        active.set(orphan.id, controller);
        void pump(orphan, controller).catch((error) => {
            active.delete(orphan.id);
            fail(orphan.id, String(error));
        });
        console.log(`[boot] 録画を再開: ${orphan.name} (${orphan.service_name})`);
        resumed++;
    }
    if (resumed > 0) emit('recordings');
    return { resumed, failed };
}
