import type { ChannelType } from '../types';
import { config } from './config';

export interface MirakurunService {
    id: number;
    serviceId: number;
    networkId: number;
    name: string;
    type: number;
    remoteControlKeyId?: number;
    channel?: { type: ChannelType; channel: string };
}

export interface MirakurunProgram {
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
    audios?: { componentType: number }[];
}

export interface MirakurunTuner {
    index: number;
    name: string;
    types: ChannelType[];
    isAvailable: boolean;
    isFault: boolean;
}

async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${config.mirakurunUrl}${path}`, {
        headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`mirakurun ${path} -> ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
}

export function getServices(): Promise<MirakurunService[]> {
    return get<MirakurunService[]>('/api/services');
}

export function getPrograms(): Promise<MirakurunProgram[]> {
    return get<MirakurunProgram[]>('/api/programs');
}

export function getTuners(): Promise<MirakurunTuner[]> {
    return get<MirakurunTuner[]>('/api/tuners');
}

/**
 * サービス単位のTSストリームを開く。番組単位の `/api/programs/:id/stream` は
 * Mirakurun 側が終了判定を持ってしまい前後マージンを自分で決められないため使わない。
 */
export async function openServiceStream(
    serviceId: number,
    signal: AbortSignal,
    priority = 2,
): Promise<ReadableStream<Uint8Array>> {
    const url = `${config.mirakurunUrl}/api/services/${serviceId}/stream?decode=1`;
    const res = await fetch(url, {
        signal,
        headers: {
            // 録画は2、ライブ視聴は0。チューナーが足りなくなったら Mirakurun が
            // 優先度の低い視聴側を切り、録画を通す
            'X-Mirakurun-Priority': String(priority),
        },
    });
    if (!res.ok || res.body === null) {
        throw new Error(`mirakurun stream ${serviceId} -> ${res.status}`);
    }
    return res.body;
}

/** Mirakurun が生きているか。ダッシュボードの表示用 */
export async function ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
        const v = await get<{ current: string }>('/api/version');
        return { ok: true, version: v.current };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}
