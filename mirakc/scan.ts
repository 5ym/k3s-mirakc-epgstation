/**
 * チャンネルスキャン。物理チャンネルを片端から選局して、居る局を探す。
 *
 * Mirakurun の走査に合わせてある。
 *
 * - 地上波は 13〜62ch を総当たり、BS は 01〜23 の各 4 スロット、CS は 02〜24ch
 * - 1チャンネルにつき最大 20 秒待ち、NIT と SDT が**両方**揃ったら受信できたとみなす
 * - 録るに値するサービス種別だけ残す (tsinfo.SERVICE_TYPES)
 *
 * チューナーは mirakc の設定に書いてあるものをそのまま使う。台数ぶん並べて回すので、
 * 2台あれば半分の時間で終わる。スキャンの間 mirakc は止まっているので取り合いにならない。
 */

import { type FoundService, ServiceReader } from '../src/lib/ts/psi';

/**
 * 1チャンネルあたりの待ち時間。Mirakurun と同じ。
 * 電波が無ければ recisdb がすぐ落ちるので、実際にここまで待つのは受信できた局だけ
 */
const TUNE_TIMEOUT = 20_000;

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
 * 1チャンネル選局して、NIT と SDT が揃うまで読む。
 *
 * 揃った時点で打ち切る。最後まで読む必要はないし、居ない局で 20 秒待つのは
 * 総当たりだと効いてくる。
 */
export async function readServices(
    command: string,
    timeout = TUNE_TIMEOUT,
): Promise<{ services: FoundService[] | null; error: string | null }> {
    let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'>;
    try {
        proc = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'ignore' });
    } catch (error) {
        return { services: null, error: String(error) };
    }

    const reader = new ServiceReader();
    const stream = proc.stdout.getReader();
    const deadline = Date.now() + timeout;
    try {
        for (;;) {
            const left = deadline - Date.now();
            if (left <= 0) break;
            /*
             * ストリームが閉じるのを待つだけでは戻ってこない。選局コマンドを
             * kill しても、そこから起きた孫プロセスが出力側を握ったままだと
             * パイプが閉じない。締め切りが来たら自分から抜ける
             */
            const chunk = await Promise.race([stream.read(), Bun.sleep(left).then(() => null)]);
            if (chunk === null || chunk.done) break;
            if (reader.feed(chunk.value)) return { services: reader.services(), error: null };
        }
    } catch {
        // 途中で切られただけ。揃っていなければ下で「受信できません」になる
    } finally {
        stream.cancel().catch(() => {});
        proc.kill();
    }

    // 電波が無いと recisdb は何も出さずに落ちる
    if (reader.network === null) return { services: null, error: '受信できませんでした' };
    return { services: null, error: 'サービス情報が揃いませんでした' };
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
            await Promise.all(usable.map((tuner) => this.work(tuner, type, pending)));
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

    private async work(tuner: Tuner, type: ChannelType, pending: string[]): Promise<void> {
        for (;;) {
            const channel = pending.shift();
            if (channel === undefined) return;

            const { services, error } = await readServices(render(tuner.command, channel, type));
            if (error !== null) {
                this.onProgress({ line: `${channel}: ${error}`, scanned: 1 });
                continue;
            }
            if (services === null || services.length === 0) {
                this.onProgress({ line: `${channel}: 録れるサービスがありません`, scanned: 1 });
                continue;
            }

            this.found.set(`${type}:${channel}`, channelEntry(type, channel, services));
            this.onProgress({ line: `${channel}: ${services.length} サービス`, scanned: 1, channels: 1 });
        }
    }
}
