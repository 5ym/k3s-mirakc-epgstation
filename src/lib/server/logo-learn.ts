import { cpSync, createWriteStream, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceFilter } from '../ts/service-filter';
import type { ChannelType } from '../types';
import { config } from './config';
import { queryAll } from './db';
import { CURRENT_SERVICES } from './epg';
import { logoRepo } from './logo-data';
import { chunks } from './stream';
import { type AgentTuner, getTuners, openChannelStream } from './tuner';

/**
 * CM検出のロゴを**録画より先に**覚えておく。
 *
 * **番組表に出す局ロゴ (`logo.ts`) とは別物。** あちらは放送波に流れてくる絵を
 * 拾うだけだが、こちらは「画面のどこにロゴが出ているか」を **logoframe に
 * 覚えさせる** (`.lgd`)。CM検出はこれが無いと本編とCMを分けられない。
 *
 * これまでは**エンコードのときに覚えていた**。局ごとに1本目だけ、覚えながら
 * 検出することになるので、その1本の精度が落ちる。先に覚えておけば1本目から効く。
 *
 * 覚えるのに要るのは**放送を数分**だけ。番組表集めやロゴ集めと同じで、
 * **いちばん弱い優先度**で開き、録画にも番組表にも必ず譲る。
 */

/** ロゴを覚えるために掴んでおく長さ。**CMを跨げる程度に** */
const LEARN_LENGTH = 5 * 60_000;

/** 覚えるのに使う録画の上限。長さぶん掴めなかったときの保険 */
const LEARN_TIMEOUT = LEARN_LENGTH + 60_000;

/** logoframe を回す上限。実時間の数分の一で終わる */
const FRAME_TIMEOUT = 10 * 60_000;

interface Target {
    id: number;
    service_id: number;
    network_id: number;
    name: string;
    type: ChannelType;
    channel: string;
}

/** いま覚えている最中の局。二重に掴まない */
const learning = new Set<number>();

/** その局のロゴを覚えているか。**中身が1つでもあれば覚えている** */
export function learned(serviceId: number): boolean {
    try {
        return readdirSync(logoRepo(serviceId)).some((name) => name.endsWith('.lgd'));
    } catch {
        // 置き場がまだ無い = 覚えていない
        return false;
    }
}

/**
 * 同じ絵を映している局を1つにまとめる。**局名で束ねる。**
 *
 * 放送局はサブチャンネルの枠を常時流していて、マルチ編成をしていない間は
 * 本チャンネルと同じ絵が出ている。SDT の局名も同じなので、実機では
 *
 * ```
 * TOKYO MX1   23608 / 23609          フジテレビ   1056 / 1057 / 1058
 * テレビ朝日  1064 / 1065 / 1066     BS-TBS       161 / 162 / 163
 * ```
 *
 * のように並んでいた。**同じ絵なのでロゴは1つ覚えれば足りる。** 束ねずに
 * 回していた頃は、画面に「TOKYO MX1」が2つ並び、掴むほうも同じ局を
 * 3回ぶん5分ずつ塞いでいた。
 *
 * 代表は**もう覚えている局を優先**する。無ければ先頭 (呼ぶ側の並び順)。
 *
 * ネットワークもそろえて見る。局名だけで束ねると、たまたま同名の別系列を
 * 1つにしてしまう
 */
export function stations<T extends { id: number; network_id: number; name: string }>(rows: T[]): T[] {
    const groups = new Map<string, T>();
    for (const row of rows) {
        const key = `${row.network_id}:${row.name}`;
        const chosen = groups.get(key);
        if (chosen === undefined || (!learned(chosen.id) && learned(row.id))) groups.set(key, row);
    }
    return [...groups.values()];
}

/** 同じ絵を映している他の局。覚えたロゴを分け合うのに使う */
export function siblings(serviceId: number): number[] {
    return queryAll<{ id: number }>(
        `SELECT other.id FROM services me
           JOIN services other ON other.network_id = me.network_id AND other.name = me.name
          WHERE me.id = ? AND other.id != ?`,
        serviceId,
        serviceId,
    ).map((row) => row.id);
}

/**
 * まだ覚えていない局。
 *
 * **録画に使う局だけ**にする。ワンセグ (service_type 192) や、スキャンで
 * 消えた古い局まで掴みに行っても意味がない。
 */
export function missing(): Target[] {
    return pending(
        stations(
            queryAll<Target>(`
                SELECT id, service_id, network_id, name, type, channel
                FROM services
                WHERE ${CURRENT_SERVICES} AND service_type = 1
                ORDER BY remote_control_key IS NULL, remote_control_key, id
            `),
        ),
    );
}

/**
 * まだ覚えていない局だけ残す。**DB を見ないので、そのまま試せる。**
 *
 * 誰を掴みに行くかは、間違えると要らない局のためにチューナーを数分ずつ
 * 潰すことになる。SQL と分けておいて、決まりのほうを単体で当てられるようにする
 */
export function pending(services: Target[]): Target[] {
    return services.filter((service) => !learned(service.id) && !learning.has(service.id));
}

/**
 * 1局ぶん覚える。
 *
 * <p>局を選り分けてから渡す。1本の TS には同じ中継の局が全部流れていて、
 * そのまま logoframe に渡すと**別の局のロゴを覚える**ことになる。</p>
 */
export async function learn(target: Target, signal?: AbortSignal): Promise<boolean> {
    if (learning.has(target.id)) return false;
    learning.add(target.id);

    const work = mkdtempSync(join(tmpdir(), 'denpa-logo-'));
    const sample = join(work, 'sample.ts');
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), LEARN_TIMEOUT);
    const give = () => controller.abort();
    signal?.addEventListener('abort', give, { once: true });

    try {
        const stream = await openChannelStream(
            target.type,
            target.channel,
            controller.signal,
            // 何を掴んでいるのかがチューナー画面に出る
            `logo ${target.type}/${target.channel}`,
            config.priority.logo,
        );

        const filter = new ServiceFilter(target.service_id);
        const sink = createWriteStream(sample);
        const until = Date.now() + LEARN_LENGTH;
        let written = 0;
        for await (const chunk of chunks(stream)) {
            const wanted = filter.filter(chunk);
            if (wanted.length > 0) {
                sink.write(wanted);
                written += wanted.length;
            }
            if (Date.now() >= until) break;
        }
        await new Promise<void>((resolve) => sink.end(resolve));
        controller.abort();

        // 1バイトも来ていないなら、覚えさせるものが無い
        if (written === 0) return false;

        return await remember(target, sample, signal);
    } catch {
        // 掴めなかった (録画で塞がっている・電波が無い)。次の見回りでまた来る
        return false;
    } finally {
        clearTimeout(stop);
        signal?.removeEventListener('abort', give);
        rmSync(work, { recursive: true, force: true });
        learning.delete(target.id);
    }
}

/**
 * logoframe に覚えさせる。
 *
 * 出てくるもののうち**残すのは `.lgd` だけ**。コマの一覧もロゴ消しの avs も
 * ここでは要らない (置き場ごと消す)。呼び方は CM検出のときと同じにしてある
 * (`cm-jls.ts`) — 揃えておかないと、覚えたものが検出のときに使われない。
 */
async function remember(target: Target, sample: string, signal?: AbortSignal): Promise<boolean> {
    const repo = logoRepo(target.id);
    const work = mkdtempSync(join(tmpdir(), 'denpa-lgd-'));

    try {
        const proc = Bun.spawn(
            [
                `${config.jlsBin}/logoframe`,
                sample,
                '-oa',
                join(work, 'frames.txt'),
                '-o',
                join(work, 'erase.avs'),
                '-channel',
                target.name,
                '-logo-dir',
                repo,
                '-logo-samples',
                String(config.jlsLogoSamples),
                '-logo-edge-threshold',
                String(config.jlsLogoEdgeThreshold),
                '-logo-match',
                String(config.jlsLogoMatch),
                // 自動で見つからなかった局だけ、画面から教わった範囲を渡す
                ...logoArea(target.id),
            ],
            { stdout: 'ignore', stderr: 'ignore' },
        );

        const timer = setTimeout(() => proc.kill(), FRAME_TIMEOUT);
        const kill = () => proc.kill();
        signal?.addEventListener('abort', kill, { once: true });
        try {
            await proc.exited;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', kill);
        }

        /*
         * **終了コードは当てにしない。** logoframe はロゴを見つけられなくても
         * 0 で終わることがある。覚えたかどうかは `.lgd` があるかで決める
         */
        if (!learned(target.id)) return false;
        share(target.id);
        return true;
    } catch {
        // 一式が入っていないイメージもある。CM検出はエンコードのときに覚え直す
        return false;
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

/**
 * 覚えたロゴを、同じ絵を映している局にも配る。
 *
 * 束ねて1局ぶんしか掴まないので (`stations`)、そのままだとサブチャンネルの枠で
 * 録れた番組が「ロゴを覚えていない」ことになる。中身は同じなので写せば足りる。
 */
export function share(serviceId: number): void {
    const from = logoRepo(serviceId);
    for (const id of siblings(serviceId)) {
        try {
            // 向こうが自分で覚えているなら、そちらのほうが確か
            if (learned(id)) continue;
            cpSync(from, logoRepo(id), { recursive: true });
        } catch {
            // 写せなくても、その局はエンコードのときに覚え直せる
        }
    }
}

/** 画面から教わった範囲。数字4つ以外は渡さない */
function logoArea(id: number): string[] {
    const area = queryAll<{ logo_area: string | null }>('SELECT logo_area FROM services WHERE id = ?', id)[0]
        ?.logo_area;
    return typeof area === 'string' && /^\d+,\d+,\d+,\d+$/.test(area) ? ['-logo-area', area] : [];
}

/** 掴んでいる相手の居るチャンネル */
function openChannels(tuners: AgentTuner[]): Set<string> {
    const open = new Set<string>();
    for (const tuner of tuners) {
        if (tuner.channel !== null) open.add(`${tuner.channel.type}:${tuner.channel.channel}`);
    }
    return open;
}

/** その種別に、誰も掴んでいないチューナーがあるか */
function hasFree(tuners: AgentTuner[], type: ChannelType): boolean {
    return tuners.some((tuner) => !tuner.disabled && tuner.types.includes(type) && tuner.channel === null);
}

/**
 * いま掴みに行けるか。**開いている相手が居れば只。**
 *
 * エージェントは同じ物理チャンネルの読み手を相乗りさせるので、録画でも
 * 番組表集めでも、その局のチャンネルが既に開いていれば**チューナーは増えません**。
 * 空きが無いときに何もしていなかった頃は、**録画中のチャンネルなら只で
 * 覚えられるのに見送って**いました。
 */
export function openable(tuners: AgentTuner[], target: Pick<Target, 'type' | 'channel'>): boolean {
    return openChannels(tuners).has(`${target.type}:${target.channel}`) || hasFree(tuners, target.type);
}

/**
 * 只で覚えられるものを先に回す。
 *
 * 1局に5分かかるので、順番を間違えると**只で覚えられたはずの録画中の局**が
 * 終わってしまう。開いているチャンネルのものを前に出すだけで、並びは崩さない。
 */
export function ridingFirst<T extends Pick<Target, 'type' | 'channel'>>(
    tuners: AgentTuner[],
    targets: T[],
): T[] {
    const open = openChannels(tuners);
    const riding = targets.filter((target) => open.has(`${target.type}:${target.channel}`));
    return [...riding, ...targets.filter((target) => !riding.includes(target))];
}

/**
 * 定期の見回り。**1局ずつ、遠慮して。**
 *
 * 掴みに行くのは「そのチャンネルが既に開いている」(只で乗れる) か
 * 「空いているチューナーがある」ときだけ。ロゴ集め (`logo.ts`) と違って
 * **同じ局を5分続けて**読む必要はありますが、続けて読むぶんも同じ選局から
 * 出てくるので、開いている相手が居れば追加のチューナーは要りません。
 */
export async function sweep(signal?: AbortSignal): Promise<number> {
    const targets = missing();
    if (targets.length === 0) return 0;

    let tuners = await tunerList();
    if (tuners === null) return 0;

    let learnedCount = 0;
    for (const target of ridingFirst(tuners, targets)) {
        if (signal?.aborted || tuners === null) break;
        // 只で乗れないうえ空きも無い局は飛ばす。他に乗れる局があるかもしれない
        if (!openable(tuners, target)) continue;
        if (await learn(target, signal)) learnedCount++;
        // 5分掴んでいた間に、空きも開いているチャンネルも変わっている
        tuners = await tunerList();
    }
    return learnedCount;
}

/** エージェントに聞けなければ null。開きに行かない */
async function tunerList(): Promise<AgentTuner[] | null> {
    try {
        return await getTuners();
    } catch {
        return null;
    }
}

/**
 * 画面に出す数。覚えている局と、まだの局。
 *
 * **束ねて数える** (`stations`)。サブチャンネルの枠まで別に数えていた頃は、
 * 下に並ぶ一覧 (こちらも束ねてある) と数が合わなかった
 */
export function stats(): { have: number; total: number } {
    const services = stations(
        queryAll<{ id: number; network_id: number; name: string }>(
            `SELECT id, network_id, name FROM services WHERE ${CURRENT_SERVICES} AND service_type = 1`,
        ),
    );
    return { have: services.filter((service) => learned(service.id)).length, total: services.length };
}
