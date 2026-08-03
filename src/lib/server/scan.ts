import type { ChannelType } from '../types';
import { config } from './config';
import { sync } from './epg';
import { collectOnce } from './epg-collect';
import { emit } from './events';

/**
 * チャンネルスキャン。
 *
 * 実際に選局するのはチューナーエージェント (agent/scan.ts)。あちらが物理チャンネルを
 * 総当たりして、見つかった局を `channels.json` に書く。
 *
 * denpa は開始を投げて、進み具合を読み、終わったら局を取り込み直すだけ。
 * **番組表を集め直すのはこちらの仕事**なので、待たされるものは何も無い
 * (エージェントは何も再起動しない)。
 */

export interface ScanState {
    state: 'idle' | 'running' | 'done' | 'failed' | 'canceled';
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
};

/** 最後に読んだ状態。画面はこれを見る */
let current: ScanState = IDLE;
let watching = false;

export interface ScanOptions {
    types: ChannelType[];
}

async function fetchStatus(): Promise<ScanState> {
    const res = await fetch(`${config.agentUrl}/denpa/scan`, { signal: AbortSignal.timeout(10_000) });
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
            const before = JSON.stringify(current);
            try {
                current = await fetchStatus();
            } catch (error) {
                current = { ...current, state: 'failed', error: String(error) };
            }
            /*
             * **変わったときだけ知らせる。** 毎回流していた頃は、チューナー画面が
             * 2秒に1回まるごと読み直されていた (知らせを受けた画面は load を
             * やり直すので、エージェントへの問い合わせも2秒ごとに走っていた)
             */
            if (JSON.stringify(current) !== before) emit('scan');
            if (current.state !== 'running') break;
        }

        if (current.state === 'done') {
            /*
             * 局が入れ替わった。**取り込み直して、番組表を集め直す。**
             *
             * mirakc の頃は、ここでエージェントが mirakc を入れ直し、あちらが
             * 自分で局と番組表を取りに行くのを待っていた (1周に1時間以上)。
             * いまは番組表を持っているのが denpa なので、待つ相手が居ない
             */
            await sync().catch(() => undefined);
            emit('services');
            void collectOnce().catch(() => undefined);
        }
    } finally {
        watching = false;
    }
}

export async function start(options: ScanOptions): Promise<{ started: boolean; message: string }> {
    let result: { started: boolean; message: string };
    try {
        const res = await fetch(`${config.agentUrl}/denpa/scan`, {
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
 * 走っているスキャンを中断する。
 *
 * 地上波の総当たりは十数分かかる。始めてから「いま録りたい」に気づいたときに、
 * 待つしかないのは困る。中断しても設定は書き換えない (途中までの結果で
 * 上書きすると、まだ回っていない局の定義が消える)。
 */
export async function stop(): Promise<{ stopped: boolean; message: string }> {
    try {
        const res = await fetch(`${config.agentUrl}/denpa/scan/stop`, { method: 'POST' });
        return (await res.json()) as { stopped: boolean; message: string };
    } catch (error) {
        return { stopped: false, message: `チューナー側に繋がりません: ${error}` };
    }
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
