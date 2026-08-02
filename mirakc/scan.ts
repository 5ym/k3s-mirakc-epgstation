/**
 * チャンネルスキャン。物理チャンネルを片端から選局して、居る局を探す。
 *
 * Mirakurun の走査に合わせてある。
 *
 * - 地上波は 13〜62ch を総当たり、BS は 01〜23 の各 4 スロット、CS は 02〜24ch
 * - 1チャンネルにつき最大 30 秒待ち、NIT と SDT が**両方**揃ったら受信できたとみなす
 * - 録るに値するサービス種別だけ残す (psi.SERVICE_TYPES)
 *
 * チューナーは mirakc の設定に書いてあるものをそのまま使う。台数ぶん並べて回すので、
 * 2台あれば半分の時間で終わる。スキャンの間 mirakc は止まっているので取り合いにならない。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { type FoundService, ServiceReader } from '../src/lib/ts/psi';

/**
 * 1チャンネルあたりの待ち時間。
 *
 * 電波が無ければ recisdb がすぐ落ちるので、実際にここまで待つのは受信できた局だけ。
 * NIT は 10 秒に1回しか流れてこないうえ、選局が落ち着くまでにも数秒かかるので、
 * Mirakurun の 20 秒では取りこぼすことがある
 */
const TUNE_TIMEOUT = 30_000;
/** 止めるときの猶予。過ぎたら SIGKILL */
const KILL_GRACE = 3_000;
/** stderr は理由を出すぶんだけ持つ。落とすとなぜ失敗したか分からなくなる */
const STDERR_TAIL = 2_000;

export type ChannelType = 'GR' | 'BS' | 'CS';

export const CHANNEL_RANGES: Record<ChannelType, { min: number; max: number }> = {
    GR: { min: 13, max: 62 },
    BS: { min: 1, max: 23 },
    CS: { min: 2, max: 24 },
};

/** BS は1つの物理チャンネルに最大4本の TS が相乗りしている */
const BS_SLOTS = 4;

export interface Tuner {
    name: string;
    types: string[];
    command: string;
    disabled?: boolean;
}

export interface ChannelEntry {
    name: string;
    type: ChannelType;
    channel: string;
    services: number[];
}

/** 選局する物理チャンネルの一覧。recisdb が受け付ける書き方で返す */
export function channelsFor(type: ChannelType, minimum?: number, maximum?: number): string[] {
    const bounds = CHANNEL_RANGES[type];
    const low = minimum === undefined ? bounds.min : Math.max(minimum, bounds.min);
    const high = maximum === undefined ? bounds.max : Math.min(maximum, bounds.max);
    const range = Array.from({ length: Math.max(0, high - low + 1) }, (_, i) => low + i);

    if (type === 'GR') return range.map((ch) => `T${ch}`);
    if (type === 'BS') {
        return range.flatMap((ch) =>
            Array.from({ length: BS_SLOTS }, (_, slot) => `BS${String(ch).padStart(2, '0')}_${slot}`),
        );
    }
    return range.map((ch) => `CS${String(ch).padStart(2, '0')}`);
}

/** mirakc のチューナーコマンド (Mustache) にチャンネルを埋める */
export function render(command: string, channel: string, type: string): string {
    const values: Record<string, string> = {
        channel,
        channel_type: type,
        duration: '-',
        extra_args: '',
    };
    return command.replace(/\{\{\{?\s*([a-z_]+)\s*\}?\}\}/g, (_, name: string) => values[name] ?? '');
}

/**
 * mirakc の channels に入れる1件。
 *
 * 物理チャンネルごとに1件にする。サービスごとに分けても選局先は同じで、
 * 設定が長くなるだけ。
 */
export function channelEntry(type: ChannelType, channel: string, services: FoundService[]): ChannelEntry {
    return {
        name: channel,
        type,
        channel,
        services: services.map((service) => service.serviceId).sort((a, b) => a - b),
    };
}

/**
 * 選局コマンドを丸ごと終わらせる。
 *
 * **プロセスを1つ殺すだけでは足りない。** `sh -c` に渡すのがパイプラインだと、
 * sh を殺しても recisdb は生き残ってチューナーを掴んだままになり、次の
 * チャンネルが「デバイスが使用中」で失敗し続ける。プロセスグループごと落とす。
 *
 * 終わるまで待つのも同じ理由。待たずに次を選局すると、まだ閉じていない
 * デバイスを開きに行くことになる。
 */
async function stop(child: ChildProcess): Promise<void> {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const kill = (signal: NodeJS.Signals) => {
        try {
            // 負のPIDでプロセスグループ全体に送る (detached で起こしてある)
            process.kill(-child.pid!, signal);
        } catch {
            // もう居ない
        }
    };

    kill('SIGTERM');
    const gone = await Promise.race([exited.then(() => true), Bun.sleep(KILL_GRACE).then(() => false)]);
    if (gone) return;
    kill('SIGKILL');
    await Promise.race([exited, Bun.sleep(KILL_GRACE)]);
}

export interface ScanResult {
    services: FoundService[] | null;
    error: string | null;
    /** TS が1バイトでも来たか。アンテナの問題と読み取りの問題を分ける手掛かり */
    signal: boolean;
}

/**
 * 1チャンネル選局して、NIT と SDT が揃うまで読む。
 *
 * 揃った時点で打ち切る。最後まで読む必要はないし、居ない局で 30 秒待つのは
 * 総当たりだと効いてくる。
 *
 * 失敗の理由は分けて返す。総当たりなので「何も出なかった」と「電波は来ているが
 * 読めなかった」は原因がまるで違い、まとめてしまうと直しようがない。
 */
export async function readServices(command: string, timeout = TUNE_TIMEOUT): Promise<ScanResult> {
    let child: ChildProcess;
    try {
        child = spawn('sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        return { services: null, error: String(error), signal: false };
    }

    const reader = new ServiceReader();
    let bytes = 0;
    let message = '';

    // recisdb はうまくいかない理由を stderr に書く (デバイスが無い・使用中など)。
    // 捨てると画面には「受信できませんでした」しか出ず、原因が分からない
    child.stderr?.on('data', (chunk: Buffer) => {
        message = `${message}${chunk.toString()}`.slice(-STDERR_TAIL);
    });

    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeout);
        const finish = () => {
            clearTimeout(timer);
            resolve();
        };
        child.stdout?.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (reader.feed(chunk)) finish();
        });
        // 電波が無いと recisdb はすぐ落ちる。閉じたら待たずに次へ
        child.once('close', finish);
        child.once('error', finish);
    });

    await stop(child);

    const signal = bytes > 0;
    if (reader.complete) return { services: reader.services(), error: null, signal };

    const tail = message.trim().split('\n').at(-1)?.trim();
    const detail = tail === undefined || tail === '' ? '' : ` (${tail})`;
    if (!signal) return { services: null, error: `受信できませんでした${detail}`, signal };
    if (reader.network === null && reader.transport === null) {
        return { services: null, error: `TSは来ましたが局情報が読めません${detail}`, signal };
    }
    const missing = reader.network === null ? 'NIT' : 'SDT';
    return { services: null, error: `${missing} が来ませんでした${detail}`, signal };
}

export interface Progress {
    line?: string;
    scanned?: number;
    channels?: number;
    skipped?: number;
}

/** チューナーの台数ぶん並べて総当たりする */
export class Scanner {
    private readonly tuners: Tuner[];
    private readonly found = new Map<string, ChannelEntry>();
    /** 電波が来た(TSが1バイトでも出た)チャンネル数。種別ごとに数え直す */
    private tuned = 0;
    /** 電波は来たのに局情報が揃わなかったチャンネル。1周したあとで回し直す */
    private retry: string[] = [];

    constructor(
        tuners: Tuner[],
        private readonly onProgress: (progress: Progress) => void = () => {},
    ) {
        this.tuners = tuners.filter((tuner) => !tuner.disabled);
    }

    /** targets は [種別, チャンネル一覧] の並び。見つかった channels 定義を返す */
    async run(targets: [ChannelType, string[]][]): Promise<ChannelEntry[]> {
        for (const [type, channels] of targets) {
            const usable = this.tuners.filter((tuner) => tuner.types.includes(type));
            if (usable.length === 0) {
                this.onProgress({
                    line: `${type}: 対応するチューナーがありません`,
                    skipped: channels.length,
                });
                continue;
            }

            const pending = [...channels];
            this.tuned = 0;
            this.retry = [];
            await Promise.all(usable.map((tuner) => this.work(tuner, type, pending)));

            /*
             * 電波は来たのに揃わなかったチャンネルは、もう一度だけ回す。
             *
             * NIT は 10 秒に1回しか流れてこないので、選局が落ち着くのが遅れると
             * 待ち時間の中に1回も入らないことがある。**受信できたチャンネルだけ**を
             * 対象にするので、総当たりの時間はほとんど増えない
             */
            const retry = this.retry;
            this.retry = [];
            if (retry.length > 0) {
                this.onProgress({ line: `${type}: ${retry.length}ch をもう一度試します` });
                await Promise.all(usable.map((tuner) => this.work(tuner, type, retry, false)));
            }
            /*
             * 種別ごとに1行でまとめる。
             *
             * 「電波は来たのに局情報が揃わなかった」のか「そもそも何も来なかった」のかで
             * 疑うところがまるで違う (前者は受信環境、後者は配線やデバイス指定)。
             * 総当たりのログは何十行も流れるので、最後に要約が無いと読み取れない
             */
            const found = [...this.found.keys()].filter((key) => key.startsWith(`${type}:`)).length;
            this.onProgress({
                line: `${type}: ${channels.length}ch 中 ${this.tuned}ch で受信、うち ${found}ch で局情報が揃いました`,
            });
        }

        const order: Record<string, number> = { GR: 0, BS: 1, CS: 2 };
        return [...this.found.entries()]
            .sort(([a], [b]) => {
                const [typeA, channelA] = a.split(':');
                const [typeB, channelB] = b.split(':');
                return order[typeA] - order[typeB] || channelA.localeCompare(channelB);
            })
            .map(([, entry]) => entry);
    }

    /** first が false のときは数え直さない (同じチャンネルを2回数えないため) */
    private async work(tuner: Tuner, type: ChannelType, pending: string[], first = true): Promise<void> {
        for (;;) {
            const channel = pending.shift();
            if (channel === undefined) return;

            const { services, error, signal } = await readServices(render(tuner.command, channel, type));
            const counts = first ? { scanned: 1 } : {};
            if (first && signal) this.tuned++;

            if (error !== null) {
                // 電波は来ているのに揃わなかったものだけ、あとでもう一度回す
                if (first && signal) this.retry.push(channel);
                this.onProgress({ line: `${channel}: ${error}`, ...counts });
                continue;
            }
            if (services === null || services.length === 0) {
                this.onProgress({ line: `${channel}: 録れるサービスがありません`, ...counts });
                continue;
            }

            this.found.set(`${type}:${channel}`, channelEntry(type, channel, services));
            this.onProgress({ line: `${channel}: ${services.length} サービス`, ...counts, channels: 1 });
        }
    }
}
