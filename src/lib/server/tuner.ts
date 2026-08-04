/**
 * チューナーエージェントへの口。
 *
 * mirakc とのやり取り (`mirakc.ts`) を置き換えたもの。**相手が返すのは素のTSだけ**で、
 * 局も番組も時刻も、意味を持つものは何も返ってこない。読むのは denpa の仕事
 * ([roadmap.md](../../../docs/roadmap.md))。
 *
 * 掴み方も1つに減った。mirakc には「サービス単位」「番組単位」「チャンネル単位」の
 * 3つの開き方があったが、ここにあるのは**物理チャンネルを丸ごと**だけ。
 * 局を選り分けるのは `ts/service-filter.ts`、番組の切れ目を見るのは `ts/eit.ts`。
 */

import type { ChannelType } from '../types';
import { config } from './config';

/** エージェントが知っているチャンネル。スキャンの結果そのもの */
export interface AgentChannel {
    type: ChannelType;
    channel: string;
    networkId: number;
    transportStreamId: number;
    remoteControlKeyId: number | null;
    services: { serviceId: number; serviceType: number; name: string }[];
}

export interface AgentTuner {
    index: number;
    name: string;
    types: ChannelType[];
    disabled: boolean;
    /** 選局に使うデバイス。ここからエージェントがコマンドを組み立てる */
    device: string | null;
    /** 衛星の給電。要る構成だけ */
    lnb: string | null;
    /**
     * 選局コマンドの上書き。**設定ファイルに直に書いたときだけ入る。**
     * 画面からは渡せない (渡せると、あちらで好きなコマンドが走ってしまう)
     */
    command: string | null;
    /** いま掴んでいるチャンネル。空いていれば null */
    channel: { type: ChannelType; channel: string } | null;
    users: { use: string; priority: number }[];
    pid: number | null;
    error: string | null;
}

/** 画面から書き換えられる部分だけ */
export interface TunerConfig {
    name: string;
    types: ChannelType[];
    device: string | null;
    lnb: string | null;
    disabled: boolean;
}

/**
 * 局の内部ID。**mirakc と同じ作り方**にしてある。
 *
 * 録画も予約も `services.id` を参照しているので、ここを変えると
 * 過去の録画が辿れなくなる (docs/data.md)。
 */
export function serviceKey(networkId: number, serviceId: number): number {
    return networkId * 100000 + serviceId;
}

/** 番組のID。局の内部ID + event_id。これも mirakc と同じ */
export function programKey(networkId: number, serviceId: number, eventId: number): number {
    return serviceKey(networkId, serviceId) * 100000 + eventId;
}

async function get<T>(path: string, timeout = 10_000): Promise<T> {
    const res = await fetch(`${config.agentUrl}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
        throw new Error(`エージェント ${path} -> ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
}

export function getChannels(): Promise<AgentChannel[]> {
    return get<AgentChannel[]>('/denpa/channels');
}

/**
 * チャンネルスキャンの結果を預ける。
 *
 * **見つけたのは denpa** (総当たりの選局はエージェントに頼むが、NIT と SDT を
 * 読むのはこちら)。それでも控えを持つのはエージェントのほうにする —
 * アンテナに何が映るかは機材ごとの話で、エージェントを増やせば顔ぶれも変わる。
 *
 * `scanned` には**探した種別**を渡す。地上波だけ探したときに全部を置き換えると
 * BS と CS が設定から消える。
 */
export async function putChannels(found: AgentChannel[], scanned: ChannelType[]): Promise<AgentChannel[]> {
    const res = await fetch(`${config.agentUrl}/denpa/channels`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: found, scanned }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`チャンネルを保存できません (${res.status}) ${await res.text()}`);
    return (await res.json()) as AgentChannel[];
}

export async function getTuners(): Promise<AgentTuner[]> {
    return (await get<{ tuners: AgentTuner[] }>('/denpa/tuners')).tuners;
}

/** 定義を書いていないので自分で見つけた状態か。画面に出す */
export async function tunersDetected(): Promise<boolean> {
    return (await get<{ detected?: boolean }>('/denpa/tuners')).detected === true;
}

/**
 * 機材の定義を書き換える。
 *
 * **選局コマンドは渡さない。** 渡せるようにすると「denpa に入れた人が
 * チューナー側で好きなコマンドを走らせられる」ことになる (しかもあちらは
 * privileged)。エージェントはデバイスと種別から組み立てる。
 *
 * **空を渡すと定義そのものが消える** = 自動検出に戻す。
 */
export async function putTuners(tuners: TunerConfig[]): Promise<void> {
    const res = await fetch(`${config.agentUrl}/denpa/tuners`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tuners }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `チューナーを保存できません (${res.status})`);
    }
}

/**
 * 何のために開いたかを伝える印。チューナー画面にそのまま出る。
 *
 * **ASCII だけ**にしてある。番組名は入れず録画IDだけ渡して、読める言葉に直すのは
 * 画面側でやる (routes/tuners/+page.server.ts)。
 */
export type StreamUse = `rec ${number}` | `logo ${string}` | `epg ${string}` | `scan ${string}`;

/**
 * チューナーに空きが無い。**待って掛け直せば通る**ので、他の失敗と分ける。
 *
 * 総当たりのスキャンでここを区別できないと、録画中で塞がっていただけの
 * チャンネルを「受信できない」と判断して設定から落としてしまう。
 */
export class TunerBusyError extends Error {}

/**
 * 物理チャンネルを丸ごと開く。**掴み方はこれ1つ。**
 *
 * 同じチャンネルを誰かが既に開いていれば、エージェントが相乗りさせる
 * (チューナーは増えない)。空きが無ければ 409 が返るので、呼んだ側は待って掛け直す。
 */
export async function openChannelStream(
    type: string,
    channel: string,
    signal: AbortSignal,
    use: StreamUse,
    priority = config.priority.recording,
): Promise<ReadableStream<Uint8Array>> {
    const query = new URLSearchParams({ type, channel, priority: String(priority), use });
    const res = await fetch(`${config.agentUrl}/denpa/stream?${query}`, { signal });
    if (!res.ok || res.body === null) {
        const detail = await res.text().catch(() => '');
        if (res.status === 409) throw new TunerBusyError(`チューナーに空きがありません ${detail}`);
        throw new Error(`選局できません (${res.status}) ${detail}`);
    }
    return res.body;
}

/** エージェントが生きているか。ダッシュボードの表示用 */
export async function ping(): Promise<{ ok: boolean; tuners?: number; error?: string }> {
    try {
        const tuners = await getTuners();
        return { ok: true, tuners: tuners.length };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}
