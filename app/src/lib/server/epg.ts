import type { Service } from '../types';
import { config } from './config';
import { database, now, queryAll } from './db';
import * as mirakurun from './mirakurun';
import { applyRules } from './rules';
import { resolveConflicts } from './scheduler';
import { toHalfWidth } from './title';

const CHANNEL_TYPES = new Set(['GR', 'BS', 'CS', 'SKY']);

export function syncServices(services: mirakurun.MirakurunService[]): number {
    const stmt = database().prepare(`
        INSERT INTO services (id, service_id, network_id, name, type, channel, remote_control_key, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            service_id = excluded.service_id,
            network_id = excluded.network_id,
            name = excluded.name,
            type = excluded.type,
            channel = excluded.channel,
            remote_control_key = excluded.remote_control_key,
            updated_at = excluded.updated_at
    `);
    const at = now();
    let count = 0;
    const tx = database().transaction(() => {
        for (const s of services) {
            // channel を持たないサービス(データ放送等)は録画対象にならないので捨てる
            if (s.channel === undefined || !CHANNEL_TYPES.has(s.channel.type)) continue;
            stmt.run(
                s.id,
                s.serviceId,
                s.networkId,
                toHalfWidth(s.name ?? ''),
                s.channel.type,
                s.channel.channel,
                s.remoteControlKeyId ?? null,
                at,
            );
            count++;
        }
    });
    tx();
    return count;
}

/** デュアルモノ判定に使う componentType。enc.js が AUDIOCOMPONENTTYPE を見ているのと同じ値 */
function audioType(p: mirakurun.MirakurunProgram): number | null {
    if (p.audio?.componentType !== undefined) return p.audio.componentType;
    if (p.audios !== undefined && p.audios.length > 0) return p.audios[0].componentType;
    return null;
}

/**
 * 番組の serviceId を services.id に読み替える表を作る。
 *
 * Mirakurun の `Program.serviceId` は **ARIB のサービスID**(例: 23608)で、
 * `Service.id` の内部ID(例: 3239123608)とは別物。そのまま入れると番組表の
 * JOIN が1件も当たらず、番組が丸ごと出なくなる。networkId と合わせて引き直す。
 */
function serviceIdIndex(): Map<string, number> {
    const services = queryAll<Service>('SELECT id, network_id, service_id FROM services');
    return new Map(services.map((s) => [`${s.network_id}:${s.service_id}`, s.id]));
}

export function syncPrograms(programs: mirakurun.MirakurunProgram[]): number {
    const index = serviceIdIndex();
    const stmt = database().prepare(`
        INSERT INTO programs (id, service_id, network_id, event_id, start_at, end_at,
                              name, description, extended, genres, is_free, audio_type, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            start_at = excluded.start_at,
            end_at = excluded.end_at,
            name = excluded.name,
            description = excluded.description,
            extended = excluded.extended,
            genres = excluded.genres,
            is_free = excluded.is_free,
            audio_type = excluded.audio_type,
            updated_at = excluded.updated_at
    `);
    const at = now();
    let count = 0;
    const tx = database().transaction(() => {
        for (const p of programs) {
            // duration 0 は「終了時刻未定」を意味する。録画時間が決まらないので扱わない
            if (!p.duration) continue;
            // チャンネル設定に無いサービスの番組は録れないので捨てる
            const serviceId = index.get(`${p.networkId}:${p.serviceId}`);
            if (serviceId === undefined) continue;
            stmt.run(
                p.id,
                serviceId,
                p.networkId,
                p.eventId,
                p.startAt,
                p.startAt + p.duration,
                toHalfWidth(p.name ?? ''),
                toHalfWidth(p.description ?? ''),
                p.extended === undefined ? null : JSON.stringify(p.extended),
                p.genres === undefined ? null : JSON.stringify(p.genres.map((g) => g.lv1)),
                p.isFree ? 1 : 0,
                audioType(p),
                at,
            );
            count++;
        }
    });
    tx();
    return count;
}

/** 予約時刻の追従。放送時間が動いた番組の予約を新しい時刻に合わせる */
export function syncReservationTimes(): number {
    const changed = database()
        .prepare(
            `
        UPDATE reservations
        SET start_at = p.start_at, end_at = p.end_at, name = p.name, updated_at = ?
        FROM programs p
        WHERE p.id = reservations.program_id
          AND reservations.state IN ('scheduled', 'conflict')
          AND (reservations.start_at != p.start_at OR reservations.end_at != p.end_at)
    `,
        )
        .run(now());
    return changed.changes;
}

/** 終わった番組を消す。番組表は未来しか見ないので、直近の分だけ残せば足りる */
export function pruneOldPrograms(): number {
    const cutoff = now() - config.programRetention;
    return database().prepare('DELETE FROM programs WHERE end_at < ?').run(cutoff).changes;
}

export interface SyncResult {
    services: number;
    programs: number;
    retimed: number;
    pruned: number;
    reserved: number;
}

export async function sync(): Promise<SyncResult> {
    const [services, programs] = await Promise.all([mirakurun.getServices(), mirakurun.getPrograms()]);
    const result: SyncResult = {
        services: syncServices(services),
        programs: syncPrograms(programs),
        retimed: syncReservationTimes(),
        pruned: pruneOldPrograms(),
        reserved: 0,
    };
    result.reserved = applyRules();
    await resolveConflicts();
    return result;
}
