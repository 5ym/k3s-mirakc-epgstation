import type { ChannelType } from '../types';
import { config } from './config';
import { sync } from './epg';
import { emit } from './events';

/**
 * チャンネルスキャン。
 *
 * 実際に選局するのはチューナー側のエージェント (mirakc/agent.ts)。mirakc には
 * 走査APIが無く、設定も起動時にしか読まれないので、あちらが mirakc を止めて
 * 総当たりし、結果を config.yml に書いてから起動し直す。
 *
 * denpa は開始を投げて、進み具合を読み、終わったら番組表を取り直すだけ。
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

export interface ScanOptions {
    types: ChannelType[];
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
            await settle();
        }
    } finally {
        watching = false;
    }
}

/**
 * 局が増えなくなったと判断するまでの連続回数。
 *
 * **少ないと途中で切り上げてしまう。** mirakc は1局ずつ選局して調べていて、
 * 1つに数分かかることも、しばらく増えない時間が続くこともある。3回 (90秒) では
 * その谷を「終わった」と読み違えていた。6回 = 5分ぶん増えなければ終わりとみなす
 */
const SETTLE_STABLE = 6;
/** 様子を見る間隔 */
const SETTLE_INTERVAL = 50_000;
/** 諦めるまでの上限。地上波+BS+CS を1局ずつ選局するので、それなりにかかる */
const SETTLE_TIMEOUT = 30 * 60_000;

/**
 * 取り込みの進み具合。
 *
 * 押しても数分〜数十分かかるうえ、**時間のかかる本体は mirakc 側**なので、
 * denpa の画面からは何も起きていないように見えていた。いま何局まで来ていて、
 * 最後に増えたのがいつで、あと何分静かなら終わりとみなすのかを出す。
 */
export interface SettleState {
    running: boolean;
    /** いま denpa に取り込めている局数 */
    services: number;
    /** 始めた時刻 */
    startedAt: number | null;
    /** 最後に増えた (減った) 時刻 */
    changedAt: number | null;
    /** 増えないまま何周したか */
    quiet: number;
    /** 何周静かなら終わりとみなすか */
    needed: number;
    /** 様子を見る間隔 */
    interval: number;
}

let settle_state: SettleState = {
    running: false,
    services: 0,
    startedAt: null,
    changedAt: null,
    quiet: 0,
    needed: SETTLE_STABLE,
    interval: SETTLE_INTERVAL,
};

/** いま走っている取り込み。二重に回さない */
let settling = false;

/** 取り込みの進み具合。画面はこれを見る */
export function settleState(): SettleState {
    return settle_state;
}

/**
 * mirakc が局を拾い切るまで取り込み続ける。
 *
 * スキャンが見つけるのは**物理チャンネル**まで。そこに何局乗っているかは
 * mirakc が改めて1局ずつ選局して調べる (scan-services) ので、設定を書き戻して
 * 起動し直した直後は 0 局から始まり、数分〜数十分かけて埋まっていく。
 *
 * 以前は5秒待って1回取り込むだけだったので、**スキャンの直後は必ず空**になり、
 * その後は10分ごとの定期取り込みが拾うのを待つしかなかった。ここで増えなくなるまで
 * 見届ける。手動の「局を取り直す」も同じものを呼ぶ。
 */
export async function settle(): Promise<number> {
    if (settling) return 0;
    settling = true;
    const startedAt = Date.now();
    settle_state = {
        running: true,
        services: 0,
        startedAt,
        changedAt: startedAt,
        quiet: 0,
        needed: SETTLE_STABLE,
        interval: SETTLE_INTERVAL,
    };
    try {
        const until = startedAt + SETTLE_TIMEOUT;
        let last = -1;
        let stable = 0;
        for (;;) {
            let count = last;
            let failed = false;
            try {
                count = (await sync()).services;
            } catch {
                // mirakc がまだ起動途中。次の周回で繋がる
                failed = true;
            }
            /*
             * 取り込めなかった周回は数に入れない。以前はここでも「増えなかった」
             * 扱いにしていたので、mirakc が落ちている間に終わったことにしていた
             */
            if (!failed) stable = count === last ? stable + 1 : 0;
            settle_state = {
                ...settle_state,
                services: count,
                quiet: stable,
                changedAt: stable === 0 ? Date.now() : settle_state.changedAt,
            };
            last = count;
            // 取り込むたびに画面へ知らせる。埋まっていく様子がそのまま出る
            emit('services');
            if (stable >= SETTLE_STABLE || Date.now() >= until) return count;
            await Bun.sleep(SETTLE_INTERVAL);
        }
    } finally {
        settling = false;
        settle_state = { ...settle_state, running: false };
        // 終わったことを画面に伝える。「取り込み中…」のままボタンが戻らない
        emit('services');
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
 * 走っているスキャンを中断する。
 *
 * 地上波の総当たりは十数分かかる。始めてから「いま録りたい」に気づいたときに、
 * 待つしかないのは困る。中断しても設定は書き換えない (途中までの結果で
 * 上書きすると、まだ回っていない局の定義が消える)。
 */
export async function stop(): Promise<{ stopped: boolean; message: string }> {
    try {
        const res = await fetch(`${config.tunerAgentUrl}/denpa/scan/stop`, { method: 'POST' });
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
