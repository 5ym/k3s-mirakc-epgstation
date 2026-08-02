import type { Reservation } from '../types';
import { config } from './config';
import { assign } from './conflict';
import { database, now, queryOne } from './db';
import { emit } from './events';
import * as mirakc from './mirakc';
import { activeRecordingIds, startRecording, stopRecording } from './recorder';
import { isDraining } from './shutdown';

interface Candidate extends Reservation {
    type: string;
    channel: string;
}

/**
 * チャンネル種別ごとのチューナー本数。mirakc が落ちていて取れないときは
 * 「制限なし」を返し、予約を勝手に conflict にしない(実際に録画が始まるときに
 * mirakc 側が弾くので、予約表を壊すより実行時に失敗させるほうが害が小さい)。
 */
export async function tunerCapacity(): Promise<Map<string, number>> {
    const capacity = new Map<string, number>();
    let tuners: mirakc.MirakcTuner[];
    try {
        tuners = await mirakc.getTuners();
    } catch {
        return capacity;
    }
    for (const tuner of tuners) {
        if (tuner.isFault) continue;
        for (const type of tuner.types) {
            capacity.set(type, (capacity.get(type) ?? 0) + 1);
        }
    }
    return capacity;
}

export async function resolveConflicts(): Promise<{ accepted: number; rejected: number }> {
    const capacity = await tunerCapacity();
    const candidates = database()
        .prepare(
            `SELECT r.*, s.type AS type, s.channel AS channel
             FROM reservations r
             JOIN services s ON s.id = r.service_id
             WHERE r.state IN ('scheduled', 'conflict') AND r.end_at > ?
             ORDER BY r.start_at`,
        )
        .all(now()) as Candidate[];

    // 前後のマージンぶんチューナーを掴む時間は延びる。予約表と実行時のズレを無くすため
    // 同じ物差しで数える
    const { accepted, rejected } = assign(candidates, capacity, {
        start: config.startMargin,
        end: config.endMargin,
    });

    const at = now();
    const toScheduled = database().prepare(
        `UPDATE reservations SET state = 'scheduled', conflict_reason = NULL, updated_at = ?
         WHERE id = ? AND state = 'conflict'`,
    );
    const toConflict = database().prepare(
        `UPDATE reservations SET state = 'conflict', conflict_reason = ?, updated_at = ?
         WHERE id = ? AND state = 'scheduled'`,
    );
    const tx = database().transaction(() => {
        for (const a of accepted) toScheduled.run(at, a.id);
        for (const r of rejected) toConflict.run(r.reason, at, r.reservation.id);
    });
    tx();
    emit('reservations');

    return { accepted: accepted.length, rejected: rejected.length };
}

/**
 * 1秒ごとに呼ばれる本体。開始時刻に達した予約を録画に移し、終了時刻を過ぎた録画を止める。
 * 状態遷移は全てここに集約し、recorder.ts はストリームの読み書きだけに専念させる。
 */
export async function tick(): Promise<void> {
    const at = now();

    // 止めるほうを先にやる。次の番組が始まるときに前の録画がまだチューナーを
    // 掴んでいると、本数が足りない環境で後続が丸ごと録れない
    for (const id of activeRecordingIds()) {
        const rec = queryOne<{ end_at: number }>('SELECT end_at FROM recordings WHERE id = ?', id);
        if (rec === undefined) continue;
        if (at >= rec.end_at + config.endMargin) stopRecording(id);
    }

    // 始まらないまま終わってしまった予約を片付ける。
    // アプリが止まっていた間に放送が終わったものがここに残り続けていた
    const expired = database()
        .prepare(
            `UPDATE reservations SET state = 'missed', updated_at = ?
             WHERE state IN ('scheduled', 'conflict') AND end_at <= ?`,
        )
        .run(at, at);
    if (expired.changes > 0) emit('reservations');

    /*
     * 止められている最中は新しく始めない。始めてしまうと、
     * 「録画が終わるまで待つ」がいつまでも終わらない (shutdown.ts)。
     * 始めそこねた予約は、次の Pod が起動した直後の tick が拾う
     */
    if (isDraining()) return;

    const due = database()
        .prepare(
            `SELECT * FROM reservations
             WHERE state = 'scheduled' AND start_at - ? <= ? AND end_at > ?`,
        )
        .all(config.startMargin, at, at) as Reservation[];

    for (const reservation of due) {
        // 状態を先に進めてから録画を開始する。tick が重なっても二重に開始しない
        const claimed = database()
            .prepare(
                `UPDATE reservations SET state = 'recording', updated_at = ? WHERE id = ? AND state = 'scheduled'`,
            )
            .run(at, reservation.id);
        if (claimed.changes === 0) continue;
        await startRecording(reservation);
    }
}
