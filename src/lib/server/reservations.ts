import type { Program, Recording, Reservation } from '../types';
import { database, now, queryOne } from './db';
import { stopRecording } from './recorder';
import { resolveConflicts } from './scheduler';
import { settings } from './settings';

/** 手動予約。ルール由来の予約が既にあれば手動扱いに昇格させて優先度を上げる */
export async function reserve(
    programId: number,
    options: {
        priority?: number;
        encode?: boolean;
        keepOriginal?: boolean;
    } = {},
): Promise<Reservation> {
    const program = queryOne<Program>('SELECT * FROM programs WHERE id = ?', programId);
    if (program === undefined) throw new Error(`番組 ${programId} が見つかりません`);

    const at = now();
    // 終わった番組を予約しても録れない。予約表に並べても取り消す手間が増えるだけ
    if (program.end_at <= at) throw new Error('この番組は放送が終わっています');
    const priority = options.priority ?? 3;
    const encode = options.encode === false ? 0 : 1;
    const keepOriginal = options.keepOriginal === true ? 1 : 0;
    // コーデックとCMの扱いは全体で1つ。予約ごとには持たせない
    const { cmCut, codec } = settings();

    database()
        .prepare(
            `INSERT INTO reservations
            (program_id, rule_id, service_id, name, description, start_at, end_at,
             priority, manual, encode, keep_original, cm_cut, codec, state, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'scheduled', ?, ?)
         ON CONFLICT(program_id) DO UPDATE SET
            manual = 1,
            priority = excluded.priority,
            encode = excluded.encode,
            keep_original = excluded.keep_original,
            cm_cut = excluded.cm_cut,
            codec = excluded.codec,
            state = CASE WHEN reservations.state = 'canceled' THEN 'scheduled' ELSE reservations.state END,
            updated_at = excluded.updated_at`,
        )
        .run(
            program.id,
            program.service_id,
            program.name,
            program.description,
            program.start_at,
            program.end_at,
            priority,
            encode,
            keepOriginal,
            cmCut,
            codec,
            at,
            at,
        );

    await resolveConflicts();
    return queryOne<Reservation>('SELECT * FROM reservations WHERE program_id = ?', programId)!;
}

/**
 * 予約の取り消し。録画中なら止めて、そこまでの分は録画済みとして残す
 * (途中まででも見たいことがあるのでファイルは捨てない)。
 */
/**
 * 取り消した予約を戻す。
 *
 * ルールが作った予約を手で取り消すと、以後ルールは作り直さない
 * (`INSERT OR IGNORE` が同じ番組を弾く)。気が変わったときに戻す道がここ。
 */
export async function restore(reservationId: number): Promise<void> {
    const reservation = queryOne<Reservation>('SELECT * FROM reservations WHERE id = ?', reservationId);
    if (reservation === undefined) throw new Error('予約が見つかりません');
    if (reservation.state !== 'canceled') throw new Error('取り消した予約ではありません');
    if (reservation.end_at <= now()) throw new Error('この番組は放送が終わっています');

    database()
        .prepare(`UPDATE reservations SET state = 'scheduled', updated_at = ? WHERE id = ?`)
        .run(now(), reservationId);
    await resolveConflicts();
}

export async function cancel(reservationId: number): Promise<void> {
    const reservation = queryOne<Reservation>('SELECT * FROM reservations WHERE id = ?', reservationId);
    if (reservation === undefined) return;

    if (reservation.state === 'recording') {
        const recording = queryOne<Pick<Recording, 'id'>>(
            `SELECT id FROM recordings WHERE reservation_id = ? AND state = 'recording'`,
            reservationId,
        );
        if (recording !== undefined) stopRecording(recording.id);
    }

    database()
        .prepare(`UPDATE reservations SET state = 'canceled', updated_at = ? WHERE id = ?`)
        .run(now(), reservationId);
    await resolveConflicts();
}
