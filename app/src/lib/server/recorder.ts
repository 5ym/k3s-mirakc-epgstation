import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Program, Recording, Reservation, Service } from '../types';
import { database, now, queryOne } from './db';
import { enqueue } from './encoder';
import { moveFile } from './fsx';
import { libraryPath, recordedPath } from './library';
import { writeNfo, writeThumbnail } from './metadata';
import { openServiceStream } from './mirakurun';
import { chunks } from './stream';
import { parseTitle } from './title';

/** 録画中のストリームを止めるための口。プロセス内にしか無いので再起動で失われる(起動時に失敗扱いにする) */
const active = new Map<number, AbortController>();

export function activeRecordingIds(): number[] {
    return [...active.keys()];
}

export function stopRecording(recordingId: number): void {
    active.get(recordingId)?.abort();
}

function fail(recordingId: number, error: string): void {
    database()
        .prepare(`UPDATE recordings SET state = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .run(error, now(), recordingId);
    const rec = queryOne<{ reservation_id: number | null }>(
        'SELECT reservation_id FROM recordings WHERE id = ?',
        recordingId,
    );
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
    const controller = new AbortController();
    active.set(recording.id, controller);

    void pump(recording, controller).catch((error) => {
        active.delete(recording.id);
        fail(recording.id, String(error));
    });

    return recording;
}

async function pump(recording: Recording, controller: AbortController): Promise<void> {
    const path = recording.ts_path!;
    mkdirSync(dirname(path), { recursive: true });

    let written = 0;
    try {
        const stream = await openServiceStream(recording.service_id, controller.signal);
        const sink = Bun.file(path).writer();
        try {
            for await (const chunk of chunks(stream)) {
                written += await sink.write(chunk);
            }
        } finally {
            await sink.end();
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

/** 録画完了。エンコードするならキューに積み、しないならそのままライブラリに置く */
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

    if (reservation === undefined || reservation.encode) {
        enqueue(recording.id);
        return;
    }

    // エンコードしない設定なら生TSをそのままライブラリへ移す
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
 * プロセスが落ちた時点で録画中だった行を失敗に倒す。
 * AbortController はメモリ上にしか無いため、再起動後に再開はできない。
 */
export function failOrphanedRecordings(): number {
    const orphans = database().prepare(`SELECT id FROM recordings WHERE state = 'recording'`).all() as {
        id: number;
    }[];
    for (const orphan of orphans) {
        fail(orphan.id, 'アプリの再起動により録画が中断されました');
    }
    return orphans.length;
}
