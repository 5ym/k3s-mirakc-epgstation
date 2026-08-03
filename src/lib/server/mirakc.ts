import type { ChannelType } from '../types';
import { config } from './config';

export interface MirakcService {
    id: number;
    serviceId: number;
    networkId: number;
    name: string;
    type: number;
    remoteControlKeyId?: number;
    channel?: { type: ChannelType; channel: string };
}

export interface MirakcProgram {
    id: number;
    eventId: number;
    serviceId: number;
    networkId: number;
    startAt: number;
    duration: number;
    isFree: boolean;
    name?: string;
    description?: string;
    extended?: Record<string, string>;
    genres?: { lv1: number; lv2: number }[];
    audio?: { componentType: number };
    audios?: { componentType: number; langs?: string[]; samplingRate?: number }[];
    video?: { type?: string; resolution?: string };
}

export interface MirakcTuner {
    index: number;
    name: string;
    types: ChannelType[];
    /** 実際に動かしている選局コマンド。空なら開いていない */
    command?: string;
    pid?: number | null;
    /** いま掴んでいる相手。録画中なら denpa が入っている */
    users?: { id: string; priority: number; agent?: string }[];
    isAvailable: boolean;
    isFree?: boolean;
    isUsing?: boolean;
    isFault: boolean;
}

export interface MirakcChannel {
    type: ChannelType;
    channel: string;
    name: string;
    services?: { id: number; serviceId: number; name: string }[];
}

async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${config.mirakcUrl}${path}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`mirakc ${path} -> ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
}

export function getServices(): Promise<MirakcService[]> {
    return get<MirakcService[]>('/api/services');
}

export function getPrograms(): Promise<MirakcProgram[]> {
    return get<MirakcProgram[]>('/api/programs');
}

export function getTuners(): Promise<MirakcTuner[]> {
    return get<MirakcTuner[]>('/api/tuners');
}

/** 設定に入っている物理チャンネル。チャンネルスキャンの結果がそのまま出る */
export function getChannels(): Promise<MirakcChannel[]> {
    return get<MirakcChannel[]>('/api/channels');
}

/** 局ごとの番組表の集まり具合 */
export interface EpgProgress {
    /** `networkId:serviceId`。mirakc の内部IDは局一覧とだけ揃っているので、こちらで突き合わせる */
    key: string;
    programs: number;
    /** いちばん先の番組の終わり。ここまで番組表が埋まっている */
    until: number;
}

function serviceKey(networkId: number, serviceId: number): string {
    return `${networkId}:${serviceId}`;
}

/**
 * mirakc がどこまで番組表を集められているかを局ごとに数える。
 *
 * チャンネルスキャンをすると mirakc は局も番組表も一度捨てるので、
 * 「まだ集めている途中なのか、その局が本当に取れていないのか」が
 * 見分けられないと待つべきかどうか分からない。チューナー画面に出すためだけの集計。
 *
 * 全件 (数MB) を取るが、EPG取得が10分ごとに同じことをしているので新しい負荷ではない。
 */
export async function getEpgProgress(): Promise<EpgProgress[]> {
    const programs = await getPrograms();
    const map = new Map<string, EpgProgress>();
    for (const program of programs) {
        const key = serviceKey(program.networkId, program.serviceId);
        const entry = map.get(key) ?? { key, programs: 0, until: 0 };
        entry.programs += 1;
        entry.until = Math.max(entry.until, program.startAt + program.duration);
        map.set(key, entry);
    }
    return [...map.values()];
}

/** 番組1つぶんの情報。放送中は EIT[p/f] で書き換わる (下記) */
export function getProgram(programId: number): Promise<MirakcProgram> {
    return get<MirakcProgram>(`/api/programs/${programId}`);
}

/** 録画は2。チューナーが足りなくなったら mirakc が優先度の低いものを切り、録画を通す */
const RECORDING_PRIORITY = 2;

async function openStream(
    path: string,
    signal: AbortSignal,
    priority: number,
    headers: Record<string, string> = {},
): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${config.mirakcUrl}${path}`, {
        signal,
        headers: { 'X-mirakc-Priority': String(priority), ...headers },
    });
    if (!res.ok || res.body === null) {
        throw new Error(`mirakc stream ${path} -> ${res.status}`);
    }
    return res.body;
}

/** サービス単位のTSストリーム。開いている間ずっと流れ続ける */
export function openServiceStream(
    serviceId: number,
    signal: AbortSignal,
    priority = RECORDING_PRIORITY,
): Promise<ReadableStream<Uint8Array>> {
    return openStream(`/api/services/${serviceId}/stream?decode=1`, signal, priority);
}

/**
 * 物理チャンネル丸ごとのTSストリーム。**ロゴを拾うのはこちら。**
 *
 * サービス単位で開くと、mirakc がその局に要るPIDだけを通す。局ロゴを載せている
 * CDT (PID 0x0029) はどの局のPMTにも載っていないので**まるごと落とされる**。
 * 実機で確かめると、BS を3分・427MB 読んでも CDT は1つも来ず、同じ局を
 * チャンネル丸ごとで開くと通った。
 *
 * ロゴはもともと物理チャンネル単位で集めるもの (1本のTSにその中継に乗っている
 * 局のぶんが順に流れてくる) なので、開き方もこちらに揃える。
 */
export function openChannelStream(
    type: string,
    channel: string,
    signal: AbortSignal,
    priority = RECORDING_PRIORITY,
): Promise<ReadableStream<Uint8Array>> {
    // decode=1 は付けない。スクランブルを解く必要があるのは映像と音声で、
    // ロゴが載っている表は元から素のまま流れてくる
    return openStream(
        `/api/channels/${encodeURIComponent(type)}/${encodeURIComponent(channel)}/stream`,
        signal,
        priority,
    );
}

/**
 * 番組単位のTSストリーム。**放送に追従する。**
 *
 * mirakc は EIT[p/f] (いま流れている番組) を見て、番組が始まるまで1バイトも出さず、
 * 番組が終わった2秒後に閉じる。番組表の時刻ではなく実際の放送で切れるので、
 * 野球で押した番組も最後まで録れるし、頭に前番組が混ざることもない。
 *
 * User-Agent が `EPGStation/` で始まると、mirakc は**このストリームに相乗りする
 * 一時的な追従役**を立てる (onair/manager.rs の SpawnTemporalTracker。
 * `uses.tuner` は空で stream_id を渡すので、チューナーは増えない)。おかげで
 * `/api/programs/:id` の時刻が放送に合わせて書き換わり、denpa 側から延長を読める。
 * 設定で立てる追従役はチューナーを1本専有するので、こちらに乗るほうが安い。
 */
export function openProgramStream(
    programId: number,
    signal: AbortSignal,
    priority = RECORDING_PRIORITY,
): Promise<ReadableStream<Uint8Array>> {
    return openStream(`/api/programs/${programId}/stream?decode=1`, signal, priority, {
        'User-Agent': 'EPGStation/denpa',
    });
}

/* ロゴは mirakc から取らない。mirakc は TS からロゴを集めないので、
   denpa が放送波から自分で拾って持つ (server/logo.ts、docs/data.md) */

/** mirakc が生きているか。ダッシュボードの表示用 */
export async function ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
        const v = await get<{ current: string }>('/api/version');
        return { ok: true, version: v.current };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}
