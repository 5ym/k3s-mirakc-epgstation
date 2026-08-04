/**
 * チャンネルスキャン。物理チャンネルを片端から選局して、居る局を探す。
 *
 * **選局はエージェントに頼み、読むのはこちら。** エージェントは中身を読まないので
 * ([roadmap.md](../../../docs/roadmap.md))、NIT と SDT を解いて局名を取るのは
 * denpa の仕事になる。局名は ARIB の文字符号で入っていて、その解読器は
 * `ts/aribtext.ts` にしかない。
 *
 * Mirakurun の走査に合わせてある。
 *
 * - 地上波は 13〜62ch を総当たり、BS は 01〜23 の各 4 スロット、CS は 02〜24ch
 * - 1チャンネルにつき最大 30 秒待ち、NIT と SDT が**両方**揃ったら受信できたとみなす
 * - 録るに値するサービス種別だけ残す (`psi.SERVICE_TYPES`)
 *
 * **録画中でも実行できる。** 選局はエージェントの取り合いに乗るので、録画が
 * 掴んでいるチューナーは使われないだけ (空きが無ければ待ち、飛ばさない)。
 */

import { type FoundService, ServiceReader } from '../ts/psi';
import type { ChannelType } from '../types';
import { config } from './config';
import { sync } from './epg';
import { collectOnce } from './epg-collect';
import { emit } from './events';
import { type AgentChannel, getTuners, openChannelStream, putChannels, TunerBusyError } from './tuner';

/**
 * 1チャンネルあたりの待ち時間。
 *
 * 電波が無ければ選局がすぐ落ちるので、実際にここまで待つのは受信できた局だけ。
 * NIT は 10 秒に1回しか流れてこないうえ、選局が落ち着くまでにも数秒かかるので、
 * Mirakurun の 20 秒では取りこぼすことがある
 */
const TUNE_TIMEOUT = 30_000;

/** チューナーが空くのを待ち直す間隔。録画が終われば空く */
const BUSY_RETRY = 10_000;

/** 記録しておく行数。総当たりは何十行も流れる */
const LOG_LIMIT = 400;

/** 総当たりできる種別。`SKY` (スカパー!プレミアム) は持っていないので対象外 */
export type ScannableType = Extract<ChannelType, 'GR' | 'BS' | 'CS'>;

export const CHANNEL_RANGES: Record<ScannableType, { min: number; max: number }> = {
    GR: { min: 13, max: 62 },
    BS: { min: 1, max: 23 },
    CS: { min: 2, max: 24 },
};

/** BS は1つの物理チャンネルに最大4本の TS が相乗りしている */
const BS_SLOTS = 4;

/** 選局する物理チャンネルの一覧。エージェントが受け付ける書き方で返す */
export function channelsFor(type: ScannableType, minimum?: number, maximum?: number): string[] {
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

/**
 * **同じ TS を指している枠か。** 指していれば、先に見つけたほうの名前を返す。
 *
 * 衛星は1つの周波数に何本もの TS が相乗りしていて、`BS01_0` のような
 * **相対番号**で選ぶ。ところが実際に何本乗っているかは中継ごとに違い、
 * 無い番号を指すと**復調器は先頭の TS を返す** (断ってはくれない)。
 *
 * その結果、実機では 35 枠のうち **9 枠が既に知っている TS の写し**だった
 * (`BS01_3` = `BS01_0`、`BS05_2` と `BS05_3` = `BS05_0` …)。放っておくと
 * 番組表集めが同じ TS を二度三度と開きに行くので、ここで落とす。
 *
 * **中身は1つも減りません。** 実機で見つかった BS の 26 TS は、放送自身が
 * 名乗っている 26 TS と一致していました (docs/roadmap.md)。
 */
export function twinOf(found: Iterable<AgentChannel>, entry: AgentChannel): string | null {
    // TSID が分からないものは判断できない。地上波は1周波数1TSなので、そもそも起きない
    if (entry.transportStreamId <= 0) return null;
    for (const other of found) {
        if (other.type === entry.type && other.transportStreamId === entry.transportStreamId) {
            return other.channel;
        }
    }
    return null;
}

/** スキャンで分かったことを1件にまとめる */
export function channelEntry(type: ScannableType, channel: string, services: FoundService[]): AgentChannel {
    const first = services[0];
    return {
        type,
        channel,
        networkId: first?.networkId ?? 0,
        transportStreamId: first?.transportStreamId ?? 0,
        remoteControlKeyId: first?.remoteControlKeyId ?? null,
        services: services
            .map((service) => ({
                serviceId: service.serviceId,
                serviceType: service.serviceType,
                name: service.name,
            }))
            .sort((a, b) => a.serviceId - b.serviceId),
    };
}

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

let current: ScanState = IDLE;
/** 走っているスキャン。中断のために持っておく */
let running: Scanner | null = null;

function push(
    line?: string,
    counts: { scanned?: number; channels?: number; skipped?: number } = {},
    fields: Partial<ScanState> = {},
): void {
    current = {
        ...current,
        ...fields,
        log: line === undefined ? current.log : [...current.log, line].slice(-LOG_LIMIT),
        scanned: current.scanned + (counts.scanned ?? 0) + (counts.skipped ?? 0),
        channels: current.channels + (counts.channels ?? 0),
    };
    emit('scan');
}

interface Progress {
    line?: string;
    scanned?: number;
    channels?: number;
    skipped?: number;
}

/** 総当たりの1件。どの種別のどの物理チャンネルか */
interface Job {
    type: ScannableType;
    channel: string;
}

/** チューナーの台数ぶん並べて総当たりする */
class Scanner {
    /** 中断の合図。押されたら選局を切り、残りのチャンネルには行かない */
    private readonly aborter = new AbortController();
    private readonly found = new Map<string, AgentChannel>();
    /** 電波が来た(TSが1バイトでも出た)チャンネル数。種別ごと */
    private readonly tuned = new Map<ScannableType, number>();
    /** 電波は来たのに局情報が揃わなかったチャンネル。1周したあとで回し直す */
    private retry: Job[] = [];

    constructor(private readonly onProgress: (progress: Progress) => void) {}

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

    /** targets は [種別, チャンネル一覧] の並び。見つかったチャンネル定義を返す */
    async run(targets: [ScannableType, string[]][]): Promise<AgentChannel[]> {
        const tuners = (await getTuners().catch(() => [])).filter((tuner) => !tuner.disabled);

        /*
         * **種別をまたいで1つの列にする。**
         *
         * 種別ごとに順に回していた頃は、地上波を50ch 撃ち終わるまで衛星に
         * 行かなかった。使うチューナーが別なので、待たせている間ずっと
         * 衛星の本が遊んでいる。1つの列を全チューナーで引けば同時に進む
         */
        const queue: Job[] = [];
        for (const [type, channels] of targets) {
            if (!tuners.some((tuner) => tuner.types.includes(type))) {
                this.onProgress({
                    line: `${type}: 対応するチューナーがありません`,
                    skipped: channels.length,
                });
                continue;
            }
            for (const channel of channels) queue.push({ type, channel });
        }

        /** その本で引けるものが1つでもある本だけ動かす */
        const wanted = new Set(queue.map((job) => job.type));
        const workers = tuners.filter((tuner) =>
            tuner.types.some((type) => wanted.has(type as ScannableType)),
        );

        if (workers.length > 0) {
            await Promise.all(workers.map((tuner) => this.work(tuner.types, queue)));

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
                this.onProgress({ line: `${retry.length}ch をもう一度試します` });
                await Promise.all(workers.map((tuner) => this.work(tuner.types, retry, false)));
            }
        }

        /*
         * 種別ごとに1行でまとめる。
         *
         * 「電波は来たのに局情報が揃わなかった」のか「そもそも何も来なかった」のかで
         * 疑うところがまるで違う (前者は受信環境、後者は配線やデバイス指定)。
         * 総当たりのログは何十行も流れるので、最後に要約が無いと読み取れない
         */
        for (const [type, channels] of targets) {
            const found = [...this.found.keys()].filter((key) => key.startsWith(`${type}:`)).length;
            const tuned = this.tuned.get(type) ?? 0;
            this.onProgress({
                line: `${type}: ${channels.length}ch 中 ${tuned}ch で受信、うち ${found}ch で局情報が揃いました`,
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

    /** その本で引ける先頭の1件を取り出す。引けないものは飛ばして次を見る */
    private take(queue: Job[], types: ChannelType[]): Job | undefined {
        const at = queue.findIndex((job) => types.includes(job.type));
        return at === -1 ? undefined : queue.splice(at, 1)[0];
    }

    /**
     * チューナー1本ぶんの担当。列が尽きるまで引き続ける。
     *
     * `types` はその本が受けられる種別。地上波の本は地上波の分だけ、衛星の本は
     * 衛星の分だけを引くので、片方が先に終わってももう片方は止まらない。
     *
     * first が false のときは数え直さない (同じチャンネルを2回数えないため)
     */
    private async work(types: ChannelType[], queue: Job[], first = true): Promise<void> {
        for (;;) {
            if (this.aborted) return;
            const job = this.take(queue, types);
            if (job === undefined) return;
            const { type, channel } = job;

            /*
             * 1チャンネルごとに切る口を持つ。読み終えたらここで接続を落とし、
             * エージェントにチューナーを返す
             */
            const closer = new AbortController();
            let stream: ReadableStream<Uint8Array>;
            try {
                stream = await openChannelStream(
                    type,
                    channel,
                    closer.signal,
                    `scan ${channel}`,
                    config.priority.scan,
                );
            } catch (error) {
                /*
                 * チューナーが全部塞がっている。**飛ばさずに待つ。**
                 * 録画中のチューナーは蹴れないので、ここで諦めるとその
                 * チャンネルだけ設定から消える
                 */
                if (error instanceof TunerBusyError) {
                    this.onProgress({ line: `${channel}: 空きを待っています` });
                    queue.unshift(job);
                    await Bun.sleep(BUSY_RETRY);
                    continue;
                }
                const counts = first ? { scanned: 1 } : {};
                this.onProgress({ line: `${channel}: ${error}`, ...counts });
                continue;
            }

            const { services, error, signal } = await readServices(stream, TUNE_TIMEOUT, this.aborter.signal);
            closer.abort();
            if (this.aborted) return;
            const counts = first ? { scanned: 1 } : {};
            if (first && signal) this.tuned.set(type, (this.tuned.get(type) ?? 0) + 1);

            if (error !== null) {
                // 電波は来ているのに揃わなかったものだけ、あとでもう一度回す
                if (first && signal) this.retry.push(job);
                this.onProgress({ line: `${channel}: ${error}`, ...counts });
                continue;
            }
            if (services === null || services.length === 0) {
                this.onProgress({ line: `${channel}: 録れるサービスがありません`, ...counts });
                continue;
            }

            const entry = channelEntry(type, channel, services);
            const twin = twinOf(this.found.values(), entry);
            if (twin !== null) {
                // 無い相対番号を指したので、先頭の TS が返ってきただけ
                this.onProgress({
                    line: `${channel}: ${twin} と同じ TS (${entry.transportStreamId}) なので使いません`,
                    ...counts,
                });
                continue;
            }

            this.found.set(`${type}:${channel}`, entry);
            this.onProgress({ line: `${channel}: ${services.length} サービス`, ...counts, channels: 1 });
        }
    }
}

export interface ScanOptions {
    types: ChannelType[];
}

async function runScan(targets: [ScannableType, string[]][]): Promise<void> {
    const scanner = new Scanner((progress) => push(progress.line, progress));
    running = scanner;
    try {
        push('チャンネルを探しています...', {}, { phase: 'スキャン中' });
        const found = await scanner.run(targets);

        /*
         * 中断されたら**何も書かない**。
         * 途中までの結果で上書きすると、まだ回っていない種別やチャンネルの
         * 定義が消える。押した人は「やめたい」だけで「消したい」ではない
         */
        if (scanner.aborted) {
            push('中断しました', {}, { state: 'canceled', phase: '中断', finishedAt: Date.now() });
            return;
        }

        // 1件も見つからないまま上書きすると、今まで録れていた局まで消える
        if (found.length === 0) {
            throw new Error('チャンネルが1件も見つかりませんでした。チューナーとアンテナを確認してください');
        }

        push('チャンネルを保存しています...', {}, { phase: '保存' });
        await putChannels(
            found,
            targets.map(([type]) => type),
        );
        push('完了しました', {}, { state: 'done', phase: '完了', finishedAt: Date.now() });

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
    } catch (error) {
        push(`失敗しました: ${error}`, {}, { state: 'failed', error: String(error), finishedAt: Date.now() });
    } finally {
        running = null;
    }
}

export function start(options: ScanOptions): { started: boolean; message: string } {
    const types = options.types.filter((type): type is ScannableType => type in CHANNEL_RANGES);
    if (types.length === 0) return { started: false, message: 'チャンネル種別の指定が不正です' };
    if (current.state === 'running') return { started: false, message: '既に実行中です' };

    // 範囲は決め打ち。放送で使う物理チャンネルは決まっていて、狭めても
    // 総当たりの時間が少し減るだけ。狭めた結果 見つからない局が出るほうが困る
    const targets: [ScannableType, string[]][] = types.map((type) => [type, channelsFor(type)]);

    current = {
        state: 'running',
        phase: '準備中',
        log: [],
        scanned: 0,
        total: targets.reduce((sum, [, channels]) => sum + channels.length, 0),
        channels: 0,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
    };
    emit('scan');
    void runScan(targets);
    return { started: true, message: 'チャンネルスキャンを始めました' };
}

/**
 * 走っているスキャンを中断する。
 *
 * 地上波の総当たりは十数分かかる。始めてから「いま録りたい」に気づいたときに、
 * 待つしかないのは困る。中断しても設定は書き換えない (途中までの結果で
 * 上書きすると、まだ回っていない局の定義が消える)。
 */
export function stop(): { stopped: boolean; message: string } {
    if (current.state !== 'running' || running === null) {
        return { stopped: false, message: '実行中ではありません' };
    }
    running.stop();
    push('中断しています...', {}, { phase: '中断中' });
    return { stopped: true, message: 'チャンネルスキャンを中断しています' };
}

/**
 * いまの状況。
 *
 * **走らせているのは denpa 自身**なので、聞きに行く先は無い。denpa を入れ替えれば
 * スキャンも一緒に落ちるので、`idle` に戻るのが正しい (エージェントに持たせて
 * いた頃は、走っていないのに「スキャン中」が残ることがあった)。
 */
export function refresh(): ScanState {
    return current;
}
