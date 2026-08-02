import type { ChannelType } from '../types';
import { config } from './config';

export interface MirakcService {
    id: number;
    serviceId: number;
    networkId: number;
    name: string;
    type: number;
    remoteControlKeyId?: number;
    hasLogoData?: boolean;
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

/**
 * サービス単位のTSストリームを開く。番組単位の `/api/programs/:id/stream` は
 * mirakc 側が終了判定を持ってしまい前後マージンを自分で決められないため使わない。
 */
export async function openServiceStream(
    serviceId: number,
    signal: AbortSignal,
    priority = 2,
): Promise<ReadableStream<Uint8Array>> {
    const url = `${config.mirakcUrl}/api/services/${serviceId}/stream?decode=1`;
    const res = await fetch(url, {
        signal,
        headers: {
            // 録画は2。チューナーが足りなくなったら mirakc が
            // 優先度の低いものを切り、録画を通す
            'X-mirakc-Priority': String(priority),
        },
    });
    if (!res.ok || res.body === null) {
        throw new Error(`mirakc stream ${serviceId} -> ${res.status}`);
    }
    return res.body;
}

/**
 * 局ロゴ。mirakc が放送波から拾ったものをそのまま中継する。
 * ロゴを持たない局もあるので、無いときは null を返して呼び出し側で出し分ける。
 */
export async function fetchLogo(serviceId: number): Promise<Response | null> {
    const res = await fetch(`${config.mirakcUrl}/api/services/${serviceId}/logo`);
    if (!res.ok || res.body === null) return null;
    return res;
}

/** mirakc が生きているか。ダッシュボードの表示用 */
export async function ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
        const v = await get<{ current: string }>('/api/version');
        return { ok: true, version: v.current };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}
