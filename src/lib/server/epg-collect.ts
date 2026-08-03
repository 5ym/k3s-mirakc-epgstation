/**
 * 番組表を集める。**mirakc の `epg.update-schedules` に当たるもの。**
 *
 * あちらとの違いは3つで、どれも「denpa が全部持っている」ことから来ている。
 *
 * - **チューナーが空いているだけ並列に回す。** mirakc は1本ずつ順に回していて、
 *   52チャンネルの1周に1時間以上かかっていた (実測)
 * - **順番を決められる。** 番組表が薄い局から先に行く
 * - **録画と同居できる。** 録画で開いているチャンネルなら、エージェントが
 *   相乗りさせるのでチューナーは増えない。番組表はただで手に入る
 *
 * 集め終わりは時間ではなく**EIT自身が言っている**ところで決める
 * (`ts/eit.ts` の ScheduleProgress)。揃えばすぐ離すので、次のチャンネルへ回せる。
 */

import { EpgReader } from '../ts/eit';
import { config } from './config';
import { queryAll } from './db';
import { savePrograms, settle, syncServices } from './epg';
import { emit } from './events';
import { resolveConflicts } from './scheduler';
import { chunks } from './stream';
import { type AgentChannel, getChannels, getTuners, openChannelStream, serviceKey } from './tuner';

/** 最後に集め終わった時刻。`type:channel` ごと */
const collected = new Map<string, number>();

const key = (channel: AgentChannel) => `${channel.type}:${channel.channel}`;

export interface CollectState {
    running: boolean;
    /** いま開いているチャンネル */
    active: string[];
    /** この周回で残っている数 */
    pending: number;
    startedAt: number | null;
    finishedAt: number | null;
    /** 直近の周回で取り込んだ番組数 */
    programs: number;
}

let state: CollectState = {
    running: false,
    active: [],
    pending: 0,
    startedAt: null,
    finishedAt: null,
    programs: 0,
};

export function collectState(): CollectState {
    return state;
}

function update(patch: Partial<CollectState>): void {
    state = { ...state, ...patch };
    emit('tuners');
}

/**
 * 局ごとに番組表がどこまで先まで埋まっているか。
 *
 * **再起動しても分かる指標**なので、ここを見て「先に行くべきチャンネル」を決める。
 * 記憶だけで持っていると、Pod が入れ替わるたびに全チャンネルを回し直すことになる。
 */
function coverage(): Map<number, number> {
    const rows = queryAll<{ service_id: number; until: number }>(
        'SELECT service_id, MAX(end_at) AS until FROM programs GROUP BY service_id',
    );
    return new Map(rows.map((row) => [row.service_id, row.until]));
}

interface Work {
    channel: AgentChannel;
    /** この物理チャンネルに乗っている局のうち、いちばん薄いものの残り時間 */
    reach: number;
    last: number;
}

/**
 * この周回で回すチャンネルを選ぶ。
 *
 * 集め直すのは「しばらく行っていない」か「番組表が薄い」チャンネル。
 * **薄いほうから先に**行く — スキャンの直後や初回起動では全部が空なので、
 * ここが効いて画面に番組が出るまでが早くなる。
 */
export function pickChannels(
    channels: AgentChannel[],
    reachOf: (channel: AgentChannel) => number,
    at: number,
): AgentChannel[] {
    const work: Work[] = channels.map((channel) => ({
        channel,
        reach: reachOf(channel),
        last: collected.get(key(channel)) ?? 0,
    }));

    return work
        .filter(
            (item) => item.reach - at < config.epgMinCoverage || at - item.last >= config.epgChannelInterval,
        )
        .sort((a, b) => a.reach - b.reach || a.last - b.last)
        .map((item) => item.channel);
}

/** 1チャンネル開いて、番組表が揃うまで読む */
async function collectChannel(channel: AgentChannel): Promise<number> {
    const reader = new EpgReader();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.epgChannelTimeout);
    timer.unref?.();

    const label = key(channel);
    update({ active: [...state.active, label] });
    try {
        const stream = await openChannelStream(
            channel.type,
            channel.channel,
            controller.signal,
            `epg ${channel.channel}`,
            config.priority.epg,
        );
        for await (const chunk of chunks(stream)) {
            if (reader.feed(chunk) && reader.complete) break;
        }
    } catch (error) {
        // 掴めなかった・途中で切れた。**読めたところまでは取り込む** —
        // 電波が弱い局で1件も入らないより、半分でも埋まっているほうがいい
        if (!controller.signal.aborted) {
            console.warn(`[epg] ${label} を集められませんでした: ${error}`);
        }
    } finally {
        clearTimeout(timer);
        controller.abort();
        update({ active: state.active.filter((name) => name !== label) });
    }

    const events = reader.all();
    if (events.length === 0) return 0;
    const saved = savePrograms(events);
    collected.set(label, Date.now());
    return saved;
}

/**
 * 1周する。
 *
 * 並列数は**その種別のチューナーの本数**。エージェントが取り合いを裁くので
 * 多めに投げても壊れはしないが、録画のために空けておきたいので数は守る。
 */
let inflight: Promise<number> | null = null;

export function collectOnce(): Promise<number> {
    /*
     * **走っている最中に呼ばれたら、その回に相乗りする。** 断って 0 を返していると、
     * 起動直後の1周と手で押したぶんが重なったときに「取り込めていない」ように見える
     */
    if (inflight !== null) return inflight;
    inflight = run().finally(() => {
        inflight = null;
    });
    return inflight;
}

async function run(): Promise<number> {
    const channels = await getChannels().catch(() => [] as AgentChannel[]);
    if (channels.length === 0) return 0;
    // 局の一覧はここでも取り込んでおく。スキャンの直後に呼ばれることがある
    syncServices(channels);

    const reach = coverage();
    const at = Date.now();
    const targets = pickChannels(
        channels,
        (channel) => {
            const reaches = channel.services.map(
                (service) => reach.get(serviceKey(channel.networkId, service.serviceId)) ?? 0,
            );
            // 乗っている局のうち、いちばん薄いものに合わせる
            return reaches.length === 0 ? 0 : Math.min(...reaches);
        },
        at,
    );
    if (targets.length === 0) return 0;

    const tuners = await getTuners().catch(() => []);
    const lanes = new Map<string, number>();
    for (const tuner of tuners) {
        if (tuner.disabled) continue;
        for (const type of tuner.types) lanes.set(type, (lanes.get(type) ?? 0) + 1);
    }

    update({ running: true, startedAt: at, finishedAt: null, pending: targets.length, programs: 0 });
    let programs = 0;
    try {
        // 種別ごとに分けて、その種別のチューナー本数だけ並べる
        const byType = new Map<string, AgentChannel[]>();
        for (const channel of targets) {
            byType.set(channel.type, [...(byType.get(channel.type) ?? []), channel]);
        }

        await Promise.all(
            [...byType.entries()].map(async ([type, queue]) => {
                const width = Math.max(1, lanes.get(type) ?? 1);
                await Promise.all(
                    Array.from({ length: width }, async () => {
                        for (;;) {
                            const channel = queue.shift();
                            if (channel === undefined) return;
                            update({ pending: state.pending - 1 });
                            programs += await collectChannel(channel);
                        }
                    }),
                );
            }),
        );
    } finally {
        update({ running: false, finishedAt: Date.now(), active: [], pending: 0, programs });
    }

    if (programs > 0) {
        settle(programs);
        await resolveConflicts();
        console.log(`[epg] ${targets.length} チャンネルから ${programs} 件の番組を取り込みました`);
    }
    return programs;
}
