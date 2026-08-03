import type { Service } from '../types';
import { config } from './config';
import { database, now, queryAll } from './db';
import * as mirakc from './mirakc';
import { applyRules } from './rules';
import { resolveConflicts } from './scheduler';
import { toHalfWidth } from './title';

const CHANNEL_TYPES = new Set(['GR', 'BS', 'CS', 'SKY']);

/**
 * 録画できるサービスかどうか。ARIB のサービス種別 (STD-B10) で決める。
 *
 * mirakc はデータ放送(NHKデータ1、Gガイド)もワンセグ(tvkワンセグ1)も
 * ラジオも同じ一覧で返す。これらを録っても映像は入っておらず、
 * データ放送は番組表上「24時間ぶんの1番組」になっていたりする。
 * ルールが引っかけて録画が失敗するので、取り込む時点で落とす。
 */
const DIGITAL_TV = 1;

/**
 * 「いま mirakc が知っている局」だけに絞る条件。
 *
 * 局の行は消さない。消すと、その局で録った録画や過去の予約が辿れなくなるため
 * ([data.md](../../../docs/data.md))。代わりに、**直近の取り込みで見かけなかった
 * 局は画面に出さない**。
 *
 * 取り込みでは同じ時刻を全件に入れるので、いちばん新しい `updated_at` が
 * 「最後に取り込んだ時刻」になる。それに満たないものが取り残しにあたる。
 *
 * 実機では、スキャンをやり直した結果 mirakc が知っているのは32局なのに
 * denpa 側には120局が残っていて、番組表に空の列が並んでいた。
 */
export const CURRENT_SERVICES = 'updated_at >= (SELECT MAX(updated_at) FROM services)';

function syncServices(services: mirakc.MirakcService[]): number {
    const stmt = database().prepare(`
        INSERT INTO services (id, service_id, network_id, name, type, service_type, channel,
                              remote_control_key, has_logo, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            service_id = excluded.service_id,
            network_id = excluded.network_id,
            name = excluded.name,
            type = excluded.type,
            service_type = excluded.service_type,
            channel = excluded.channel,
            remote_control_key = excluded.remote_control_key,
            updated_at = excluded.updated_at
    `);
    const at = now();
    let count = 0;
    const dropped: number[] = [];
    const tx = database().transaction(() => {
        for (const s of services) {
            if (s.channel === undefined || !CHANNEL_TYPES.has(s.channel.type)) continue;
            // 映像の入っていないサービスは録っても仕方がない
            if (s.type !== DIGITAL_TV) {
                dropped.push(s.id);
                continue;
            }
            stmt.run(
                s.id,
                s.serviceId,
                s.networkId,
                toHalfWidth(s.name ?? ''),
                s.channel.type,
                s.type,
                s.channel.channel,
                s.remoteControlKeyId ?? null,
                // ロゴは mirakc からは取れない。denpa が放送波から拾ったときに立てる
                0,
                at,
            );
            count++;
        }
        // 以前の取り込みで入ってしまったデータ放送やワンセグを片付ける。
        // 残っていると番組表に並び続け、ルールが引っかけて録画が失敗する
        for (const id of dropped) {
            database()
                .prepare(
                    // 録り始めたものは触らない。取り消しても録画は戻らない
                    `UPDATE reservations SET state = 'canceled', updated_at = ?
                     WHERE service_id = ? AND state IN ('scheduled', 'conflict') AND started_at IS NULL`,
                )
                .run(at, id);
            database().prepare('DELETE FROM programs WHERE service_id = ?').run(id);
            database().prepare('DELETE FROM services WHERE id = ?').run(id);
        }
    });
    tx();
    return count;
}

/** デュアルモノ判定に使う componentType。enc.js が AUDIOCOMPONENTTYPE を見ているのと同じ値 */
function audioType(p: mirakc.MirakcProgram): number | null {
    if (p.audio?.componentType !== undefined) return p.audio.componentType;
    if (p.audios !== undefined && p.audios.length > 0) return p.audios[0].componentType;
    return null;
}

/**
 * 番組の serviceId を services.id に読み替える表を作る。
 *
 * mirakc の `Program.serviceId` は **ARIB のサービスID**(例: 23608)で、
 * `Service.id` の内部ID(例: 3239123608)とは別物。そのまま入れると番組表の
 * JOIN が1件も当たらず、番組が丸ごと出なくなる。networkId と合わせて引き直す。
 */
function serviceIdIndex(): Map<string, number> {
    const services = queryAll<Service>('SELECT id, network_id, service_id FROM services');
    return new Map(services.map((s) => [`${s.network_id}:${s.service_id}`, s.id]));
}

function syncPrograms(programs: mirakc.MirakcProgram[]): number {
    const index = serviceIdIndex();
    const stmt = database().prepare(`
        INSERT INTO programs (id, service_id, network_id, event_id, start_at, end_at,
                              name, description, extended, genres, genre_detail,
                              is_free, audio_type, audios, video_type, video_resolution, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            -- service_id も上書きする。ここを更新しないと、一度おかしな値で入った行が
            -- 取り込み直しても直らない(番組表が空のままになる)
            service_id = excluded.service_id,
            network_id = excluded.network_id,
            start_at = excluded.start_at,
            end_at = excluded.end_at,
            name = excluded.name,
            description = excluded.description,
            extended = excluded.extended,
            genres = excluded.genres,
            genre_detail = excluded.genre_detail,
            is_free = excluded.is_free,
            audio_type = excluded.audio_type,
            audios = excluded.audios,
            video_type = excluded.video_type,
            video_resolution = excluded.video_resolution,
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
                p.genres === undefined
                    ? null
                    : JSON.stringify(p.genres.map((g) => ({ lv1: g.lv1, lv2: g.lv2 }))),
                p.isFree ? 1 : 0,
                audioType(p),
                p.audios === undefined
                    ? null
                    : JSON.stringify(
                          p.audios.map((a) => ({ componentType: a.componentType, langs: a.langs })),
                      ),
                p.video?.type ?? null,
                p.video?.resolution ?? null,
                at,
            );
            count++;
        }
    });
    tx();
    return count;
}

/**
 * 予約の追従。番組表が書き換わったぶんを、まだ始めていない予約に反映する。
 *
 * **時刻だけでなく名前と概要も見る。** 番組表は放送直前まで書き換わり
 * (「[新]」が付く、サブタイトルが入る、誤字が直る)、時刻が動かないまま名前だけ
 * 変わることがある。時刻の差だけで拾っていた頃は、予約一覧に古い名前が残り、
 * そのまま録画の名前になっていた。
 */
function syncReservationTimes(): number {
    const changed = database()
        .prepare(
            `
        UPDATE reservations
        SET start_at = p.start_at, end_at = p.end_at, name = p.name,
            description = p.description, updated_at = ?
        FROM programs p
        WHERE p.id = reservations.program_id
          AND reservations.state IN ('scheduled', 'conflict')
          -- 録り始めた予約は動かさない。延長への追従は録画の行のほうでやる
          AND reservations.started_at IS NULL
          AND (reservations.start_at != p.start_at OR reservations.end_at != p.end_at
               OR reservations.name != p.name OR reservations.description != p.description)
    `,
        )
        .run(now());
    return changed.changes;
}

/** 終わった番組を消す。番組表は未来しか見ないので、直近の分だけ残せば足りる */
function pruneOldPrograms(): number {
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
    const [services, programs] = await Promise.all([mirakc.getServices(), mirakc.getPrograms()]);
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
