import type { ChannelType } from '../types';
import { config } from './config';
import { sync } from './epg';
import { emit } from './events';

/**
 * チャンネルスキャン。
 *
 * 実際に選局するのはチューナー側のエージェント (mirakc/agent.py)。mirakc には
 * 走査APIが無く、設定も起動時にしか読まれないので、あちらが mirakc を止めて
 * 総当たりし、結果を config.yml に書いてから起動し直す。
 *
 * denpa は開始を投げて、進み具合を読み、終わったら番組表を取り直すだけ。
 */

export interface ScanState {
    state: 'idle' | 'running' | 'done' | 'failed';
    /** いま何をしているか。そのまま画面に出す */
    phase: string;
    log: string[];
    /** 選局し終えた物理チャンネル数と、その総数。進捗バーに使う */
    scanned: number;
    total: number;
    /** 見つかったチャンネル数 */
    channels: number;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    /** mirakc が動いているか。スキャンの間は止まっている */
    mirakc: boolean;
}

const IDLE: ScanState = {
    state: 'idle',
    phase: '',
    log: [],
    scanned: 0,
    total: 0,
    channels: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    mirakc: true,
};

/** 最後に読んだ状態。画面はこれを見る */
let current: ScanState = IDLE;
let watching = false;

export function status(): ScanState {
    return current;
}

export interface ScanOptions {
    types: ChannelType[];
    min?: number;
    max?: number;
}

async function fetchStatus(): Promise<ScanState> {
    const res = await fetch(`${config.tunerAgentUrl}/denpa/scan`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`チューナー側が ${res.status} を返しました`);
    return (await res.json()) as ScanState;
}

/**
 * 終わるまで見張る。
 *
 * 状態を持っているのはエージェントのほうなので、denpa は読みに行く。
 * 終わったら番組表を取り直す。スキャンで局が入れ替わっても、denpa のDBは
 * 自分では気づけないため。
 */
async function watch(): Promise<void> {
    if (watching) return;
    watching = true;
    try {
        for (;;) {
            await Bun.sleep(2000);
            try {
                current = await fetchStatus();
            } catch (error) {
                current = { ...current, state: 'failed', error: String(error) };
            }
            emit('scan');
            if (current.state !== 'running') break;
        }

        if (current.state === 'done') {
            // mirakc が新しい設定で起動し終わるまで待つ
            await Bun.sleep(5000);
            await sync();
        }
    } finally {
        watching = false;
    }
}

export async function start(options: ScanOptions): Promise<{ started: boolean; message: string }> {
    let result: { started: boolean; message: string };
    try {
        const res = await fetch(`${config.tunerAgentUrl}/denpa/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options),
        });
        result = (await res.json()) as { started: boolean; message: string };
    } catch (error) {
        return { started: false, message: `チューナー側に繋がりません: ${error}` };
    }
    if (!result.started) return result;

    try {
        current = await fetchStatus();
    } catch {
        // 開始は受け付けられている。状態は見張りが拾い直す
    }
    emit('scan');
    void watch();
    return result;
}

/**
 * 実際の状況を取りに行く。
 *
 * 状態を持っているのはエージェント側なので、denpa を入れ替えても、画面を
 * 開き直せば正しい状況が出る。以前は denpa 側で持っていて、Pod が入れ替わると
 * 「スキャン中」の表示が消えなくなっていた。
 */
export async function refresh(): Promise<ScanState> {
    try {
        current = await fetchStatus();
        if (current.state === 'running') void watch();
    } catch {
        current = IDLE;
    }
    return current;
}
