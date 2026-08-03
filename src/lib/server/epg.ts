import type { EitEvent } from '../ts/eit';
import type { Service } from '../types';
import { config } from './config';
import { database, now, queryAll, queryOne } from './db';
import { emit } from './events';
import { applyRules } from './rules';
import { resolveConflicts } from './scheduler';
import { toHalfWidth } from './title';
import { type AgentChannel, getChannels, programKey, serviceKey } from './tuner';

/**
 * 録画できるサービスかどうか。ARIB のサービス種別 (STD-B10) で決める。
 *
 * スキャンはデータ放送(NHKデータ1、Gガイド)もワンセグ(tvkワンセグ1)も
 * ラジオも同じ一覧に入れる。これらを録っても映像は入っておらず、
 * データ放送は番組表上「24時間ぶんの1番組」になっていたりする。
 * ルールが引っかけて録画が失敗するので、取り込む時点で落とす。
 */
const DIGITAL_TV = 1;

/**
 * 「いまエージェントが知っている局」だけに絞る条件。
 *
 * 局の行は消さない。消すと、その局で録った録画や過去の予約が辿れなくなるため
 * ([data.md](../../../docs/data.md))。代わりに、**直近の取り込みで見かけなかった
 * 局は画面に出さない**。
 *
 * 取り込みでは同じ時刻を全件に入れるので、いちばん新しい `updated_at` が
 * 「最後に取り込んだ時刻」になる。それに満たないものが取り残しにあたる。
 *
 * 実機では、スキャンをやり直した結果 知っているのは32局なのに denpa 側には
 * 120局が残っていて、番組表に空の列が並んでいた。
 */
export const CURRENT_SERVICES = 'updated_at >= (SELECT MAX(updated_at) FROM services)';

export function syncServices(channels: AgentChannel[]): number {
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
    /*
     * この回で見かけた局。**時刻では数えない。** `updated_at < at` で拾っていた頃は、
     * 2回の取り込みが同じミリ秒に入ると、前の回の局が「まだ見かけている」ことに
     * なっていた (時計の刻みが1msしかない)
     */
    const seen = new Set<number>();
    const tx = database().transaction(() => {
        for (const channel of channels) {
            for (const service of channel.services) {
                const id = serviceKey(channel.networkId, service.serviceId);
                // 映像の入っていないサービスは録っても仕方がない
                if (service.serviceType !== DIGITAL_TV) {
                    dropped.push(id);
                    continue;
                }
                seen.add(id);
                stmt.run(
                    id,
                    service.serviceId,
                    channel.networkId,
                    toHalfWidth(service.name),
                    channel.type,
                    service.serviceType,
                    channel.channel,
                    channel.remoteControlKeyId,
                    // ロゴは放送波から拾ったときに立てる (logo.ts)
                    0,
                    at,
                );
                count++;
            }
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
        // この回で見かけなかった局の持ち物を片付ける
        if (count > 0) canceled = forgetMissing(at, seen);
    });
    let canceled = 0;
    tx();
    // 取り消した予約は一覧に出ている。同じものを見ている端末が食い違わないように
    if (canceled > 0) emit('reservations');
    return count;
}

/**
 * 選局できなくなった局の持ち物を片付ける。
 *
 * **局の行そのものは残す。** 消すと、その局で録った録画や過去の予約が辿れなくなる
 * ([data.md](../../../docs/data.md))。片付けるのは番組表と、まだ始めていない予約。
 *
 * スキャンをやり直すと局は普通に入れ替わる。番組表を置いたままにしていた頃は、
 * もう選局できない局の番組が数万件残り、検索にも引っかかり続けていた。予約のほうは
 * 録りに行っても掴めないので、始まるのを待って失敗するより先に取り消しておく
 * (取り消した予約は一覧から戻せる)。
 *
 * **1局も取れなかった回では何もしない** (`count > 0` のときだけ呼ぶ)。エージェントが
 * 起動直後や不調で空を返すことはあり、それを「全部消えた」と読むと番組表ごと消える。
 */
function forgetMissing(at: number, seen: Set<number>): number {
    const stale = queryAll<{ id: number; name: string }>('SELECT id, name FROM services').filter(
        (service) => !seen.has(service.id),
    );
    if (stale.length === 0) return 0;

    const dropPrograms = database().prepare('DELETE FROM programs WHERE service_id = ?');
    const cancel = database().prepare(
        // 録り始めたものは触らない。取り消しても録画は戻らない
        `UPDATE reservations SET state = 'canceled', updated_at = ?
         WHERE service_id = ? AND state IN ('scheduled', 'conflict') AND started_at IS NULL`,
    );
    let programs = 0;
    let reservations = 0;
    const names: string[] = [];
    for (const service of stale) {
        const dropped = dropPrograms.run(service.id).changes;
        const canceled = cancel.run(at, service.id).changes;
        programs += dropped;
        reservations += canceled;
        if (dropped > 0 || canceled > 0) names.push(service.name);
    }
    if (programs === 0 && reservations === 0) return 0;
    console.log(
        `[epg] 選局できなくなった局を片付けました: ${names.join(', ')} ` +
            `(番組 ${programs} 件 / 予約 ${reservations} 件を取り消し)`,
    );
    return reservations;
}

/**
 * 局の一覧をエージェントから取り込む。番組表は待たない。
 *
 * **どの局が居るかはスキャンで決まる。** 番組表を集めるのはそのあとで、
 * 局によっては数分かかる。局だけ先に出しておかないと、スキャンの直後に
 * 番組表が空のまま何も出ない時間が続く。
 */
export async function syncServicesOnly(): Promise<number> {
    const current = `SELECT COUNT(*) AS n FROM services WHERE ${CURRENT_SERVICES}`;
    const before = queryOne<{ n: number }>(current)?.n ?? 0;
    const count = syncServices(await getChannels());
    /*
     * 数が変わったときだけ知らせる。毎回知らせると、番組表を開いている端末が
     * 何も変わっていないのに1分おきに読み直すことになる
     */
    if ((queryOne<{ n: number }>(current)?.n ?? 0) !== before) emit('services');
    return count;
}

/**
 * 番組の serviceId を services.id に読み替える表を作る。
 *
 * EIT が持っているのは **ARIB のサービスID**(例: 23608)で、`Service.id` の
 * 内部ID(例: 3239123608)とは別物。そのまま入れると番組表の JOIN が1件も当たらず、
 * 番組が丸ごと出なくなる。networkId と合わせて引き直す。
 */
function serviceIdIndex(): Map<string, number> {
    const services = queryAll<Service>('SELECT id, network_id, service_id FROM services');
    return new Map(services.map((s) => [`${s.network_id}:${s.service_id}`, s.id]));
}

/** 読み取った番組をDBへ。取り込めた件数を返す */
export function savePrograms(events: EitEvent[]): number {
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
        for (const event of events) {
            // 開始も尺も決まっていないものは録画の時刻が決まらない
            if (event.startAt === null || event.duration === null || event.duration === 0) continue;
            // チャンネル設定に無いサービスの番組は録れないので捨てる
            const serviceId = index.get(`${event.originalNetworkId}:${event.serviceId}`);
            if (serviceId === undefined) continue;
            const extended = Object.keys(event.extended).length === 0 ? null : event.extended;
            stmt.run(
                programKey(event.originalNetworkId, event.serviceId, event.eventId),
                serviceId,
                event.originalNetworkId,
                event.eventId,
                event.startAt,
                event.startAt + event.duration,
                toHalfWidth(event.name),
                toHalfWidth(event.description),
                extended === null ? null : JSON.stringify(extended),
                event.genres.length === 0 ? null : JSON.stringify(event.genres.map((g) => g.lv1)),
                event.genres.length === 0 ? null : JSON.stringify(event.genres),
                event.isFree ? 1 : 0,
                event.audios[0]?.componentType ?? null,
                event.audios.length === 0
                    ? null
                    : JSON.stringify(
                          event.audios.map((a) => ({ componentType: a.componentType, langs: a.langs })),
                      ),
                event.video?.type ?? null,
                event.video?.resolution ?? null,
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

/**
 * 番組表が変わったあとの片付け。
 *
 * ルールを当て直し、予約の時刻を合わせ、古い番組を捨て、取り合いを裁き直す。
 * **番組を読むところとは分けてある** — 1チャンネル集めるたびに全部やり直すと、
 * 52チャンネルぶん同じことを52回することになる。
 */
export function settle(programs = 0): SyncResult {
    const result: SyncResult = {
        services: 0,
        programs,
        retimed: syncReservationTimes(),
        pruned: pruneOldPrograms(),
        reserved: applyRules(),
    };
    emit('programs');
    return result;
}

/**
 * 局と番組表を取り込み直す。手で押したときと、起動直後に1回。
 *
 * 番組そのものを集めるのは `epg-collect.ts` で、こちらは**溜まっているものを
 * 使って予約を組み直すだけ**。
 */
export async function sync(): Promise<SyncResult> {
    const services = syncServices(await getChannels());
    const result = settle();
    result.services = services;
    await resolveConflicts();
    return result;
}
