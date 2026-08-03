import type { ChannelType } from '../types';
import { config } from './config';
import { sync } from './epg';
import { emit } from './events';
import { ping } from './mirakc';

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
            const before = JSON.stringify(current);
            try {
                current = await fetchStatus();
            } catch (error) {
                current = { ...current, state: 'failed', error: String(error) };
            }
            /*
             * **変わったときだけ知らせる。** 毎回流していた頃は、チューナー画面が
             * 2秒に1回まるごと読み直されていた (知らせを受けた画面は load を
             * やり直すので、mirakc への問い合わせも2秒ごとに走っていた)。
             * こちら側が覗きに行くのは相手 (エージェント) に押す口が無いためで、
             * 画面まで同じ間隔で叩く理由は無い
             */
            if (JSON.stringify(current) !== before) emit('scan');
            if (current.state !== 'running') break;
        }

        if (current.state === 'done') {
            /*
             * スキャンが終わると**エージェントが mirakc を入れ直す** (覚えている局も
             * 捨てる)。起動した mirakc は自分で局と番組表を取りに行き、揃うたびに
             * `/events` で知らせてくるので、denpa 側は待ち構えるだけでいい。
             *
             * 以前は「局が増えなくなるまで50秒おきに取り込み直す」見張りを回していたが、
             * 時間のかかる本体は mirakc 側で、こちらが何回聞き直しても速くならない。
             * 知らせが来たときに取り込めば足りる (docs/data.md)
             */
            await sync().catch(() => undefined);
            emit('services');
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
 * mirakc を入れ直す。
 *
 * **局が足りないときに効くのはこれだけ。** どの局が受信できるかを調べているのは
 * mirakc (`scan-services`) で、denpa から番組表を取り込み直しても、mirakc が
 * まだ知らない局は増えない。mirakc は起動したときに局と番組表を取りに行くので、
 * 入れ直すのが一番速い道になる。
 *
 * 以前あった「局を取り直す」は denpa 側で50秒おきに取り込み直すだけのもので、
 * 待っている相手 (mirakc) を急かす力は無かった。
 */
export async function restartMirakc(forget = false): Promise<{ ok: boolean; message: string }> {
    let result: { ok: boolean; message: string };
    try {
        const res = await fetch(`${config.tunerAgentUrl}/denpa/mirakc/restart`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ forget }),
            signal: AbortSignal.timeout(30_000),
        });
        result = (await res.json()) as { ok: boolean; message: string };
    } catch (error) {
        return { ok: false, message: `チューナー側に繋がりません: ${error}` };
    }
    if (result.ok) {
        // 止まっているところまでは今すぐ見せる。戻ってきたらまた知らせる
        emit('tuners');
        void waitForMirakc();
    }
    return result;
}

/** 起動を待つ上限。実機で数秒だが、番組表を抱えていると読み込みに時間がかかる */
const RESTART_WAIT = 3 * 60_000;
const RESTART_POLL = 2000;
let waiting = false;

/**
 * 入れ直した mirakc が戻ってくるのを待って、画面へ知らせる。
 *
 * 押した直後は当然まだ止まっていて、画面には「NG」が出る。戻ったことを
 * 知らせていなかった頃は、**自分で読み込み直すまで NG のまま**だった。
 * 起動した mirakc は局と番組表を取りに行くので、そこも1回取り込んでおく
 * (番組表のぶんは知らせが来るが、局が揃ったことは知らせてくれない)。
 */
async function waitForMirakc(): Promise<void> {
    if (waiting) return;
    waiting = true;
    try {
        const deadline = Date.now() + RESTART_WAIT;
        while (Date.now() < deadline) {
            await Bun.sleep(RESTART_POLL);
            if (!(await ping()).ok) continue;
            emit('tuners');
            await sync().catch(() => undefined);
            emit('services');
            return;
        }
        // 上がってこない。画面は「NG」のままで、その理由も出ている
        emit('tuners');
    } finally {
        waiting = false;
    }
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
