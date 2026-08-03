/**
 * チャンネルスキャン。物理チャンネルを片端から選局して、居る局を探す。
 *
 * Mirakurun の走査に合わせてある。
 *
 * - 地上波は 13〜62ch を総当たり、BS は 01〜23 の各 4 スロット、CS は 02〜24ch
 * - 1チャンネルにつき最大 30 秒待ち、NIT と SDT が**両方**揃ったら受信できたとみなす
 * - 録るに値するサービス種別だけ残す (psi.SERVICE_TYPES)
 *
 * **選局はチューナープールに頼む。** 自分で `recisdb` を起こしていた頃は、
 * スキャンの間じゅう mirakc を止めておく必要があった。プールが優先度で捌くように
 * なったので、**録画中でもスキャンできる** (録画のほうが強いので、そのチューナーは
 * 使われないだけ)。
 */

import { type FoundService, ServiceReader } from '../src/lib/ts/psi';
import { type ChannelEntry, type ChannelType, channelEntry } from './channels';
import type { TunerPool } from './tuners';

/**
 * 1チャンネルあたりの待ち時間。
 *
 * 電波が無ければ recisdb がすぐ落ちるので、実際にここまで待つのは受信できた局だけ。
 * NIT は 10 秒に1回しか流れてこないうえ、選局が落ち着くまでにも数秒かかるので、
 * Mirakurun の 20 秒では取りこぼすことがある
 */
const TUNE_TIMEOUT = 30_000;

/**
 * スキャンの優先度。
 *
 * **録画より下、番組表より上。** 人が押して待っているので番組表集めには譲らせるが、
 * 録画を蹴ってまでやることではない。
 */
export const SCAN_PRIORITY = 5;

/** チューナーが空くのを待ち直す間隔。録画が終われば空く */
const BUSY_RETRY = 10_000;

export const CHANNEL_RANGES: Record<ChannelType, { min: number; max: number }> = {
    GR: { min: 13, max: 62 },
    BS: { min: 1, max: 23 },
    CS: { min: 2, max: 24 },
};

/** BS は1つの物理チャンネルに最大4本の TS が相乗りしている */
const BS_SLOTS = 4;

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

export interface ScanResult {
    services: FoundService[] | null;
    error: string | null;
    /** TS が1バイトでも来たか。アンテナの問題と読み取りの問題を分ける手掛かり */
    signal: boolean;
}

/**
 * 流れてくる TS を、NIT と SDT が揃うまで読む。
 *
 * 揃った時点で打ち切る。最後まで読む必要はないし、居ない局で 30 秒待つのは
 * 総当たりだと効いてくる。
 *
 * 失敗の理由は分けて返す。総当たりなので「何も出なかった」と「電波は来ているが
 * 読めなかった」は原因がまるで違い、まとめてしまうと直しようがない。
 */
export async function readServices(
    stream: ReadableStream<Uint8Array>,
    timeout = TUNE_TIMEOUT,
    abort?: AbortSignal,
): Promise<ScanResult> {
    const reader = new ServiceReader();
    const source = stream.getReader();
    let bytes = 0;
    let message = '';

    const deadline = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeout);
        timer.unref?.();
        abort?.addEventListener('abort', () => resolve(), { once: true });
    });

    const read = (async () => {
        for (;;) {
            const { done, value } = await source.read();
            if (done || value === undefined) return;
            bytes += value.byteLength;
            if (reader.feed(value)) return;
        }
    })().catch((error: unknown) => {
        // 選局が落ちた理由はここに来る (デバイスが無い・使用中など)
        message = String(error);
    });

    await Promise.race([read, deadline]);
    await source.cancel().catch(() => undefined);

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
    /** 中断の合図。押されたら選局を殺し、残りのチャンネルには行かない */
    private readonly aborter = new AbortController();
    private readonly found = new Map<string, ChannelEntry>();
    /** 電波が来た(TSが1バイトでも出た)チャンネル数。種別ごとに数え直す */
    private tuned = 0;
    /** 電波は来たのに局情報が揃わなかったチャンネル。1周したあとで回し直す */
    private retry: string[] = [];

    constructor(
        private readonly pool: TunerPool,
        private readonly onProgress: (progress: Progress) => void = () => {},
    ) {}

    /**
     * 中断する。
     *
     * 地上波の総当たりは十数分かかる。始めてから「いま録りたい」に気づいたときに
     * 待つしかないのは困るので、途中で降りられるようにしてある
     */
    stop(): void {
        this.aborter.abort();
    }

    get aborted(): boolean {
        return this.aborter.signal.aborted;
    }

    /** targets は [種別, チャンネル一覧] の並び。見つかった channels 定義を返す */
    async run(targets: [ChannelType, string[]][]): Promise<ChannelEntry[]> {
        for (const [type, channels] of targets) {
            if (this.aborted) break;
            const usable = this.pool.tuners.filter(
                (tuner) => tuner.disabled !== true && tuner.types.includes(type),
            );
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
            await Promise.all(usable.map(() => this.work(type, pending)));

            /*
             * 電波は来たのに揃わなかったチャンネルは、もう一度だけ回す。
             *
             * NIT は 10 秒に1回しか流れてこないので、選局が落ち着くのが遅れると
             * 待ち時間の中に1回も入らないことがある。**受信できたチャンネルだけ**を
             * 対象にするので、総当たりの時間はほとんど増えない
             */
            const retry = this.retry;
            this.retry = [];
            if (retry.length > 0 && !this.aborted) {
                this.onProgress({ line: `${type}: ${retry.length}ch をもう一度試します` });
                await Promise.all(usable.map(() => this.work(type, retry, false)));
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
    private async work(type: ChannelType, pending: string[], first = true): Promise<void> {
        for (;;) {
            if (this.aborted) return;
            const channel = pending.shift();
            if (channel === undefined) return;

            let stream: ReadableStream<Uint8Array>;
            try {
                stream = this.pool.open({
                    type,
                    channel,
                    priority: SCAN_PRIORITY,
                    use: `scan ${channel}`,
                });
            } catch (error) {
                /*
                 * チューナーが全部塞がっている。**飛ばさずに待つ。**
                 * 録画中のチューナーは蹴れないので、ここで諦めるとその
                 * チャンネルだけ設定から消える
                 */
                this.onProgress({ line: `${channel}: 空きを待っています (${error})` });
                pending.unshift(channel);
                await Bun.sleep(BUSY_RETRY);
                continue;
            }

            const { services, error, signal } = await readServices(stream, undefined, this.aborter.signal);
            if (this.aborted) return;
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
