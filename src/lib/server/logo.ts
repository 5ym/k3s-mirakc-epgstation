import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LogoCollector } from '../ts/logo';
import { withPalette } from '../ts/logo-palette';
import type { ChannelType } from '../types';
import { config } from './config';
import { database, queryAll } from './db';
import { CURRENT_SERVICES } from './epg';
import { emit } from './events';
import { getTuners, type MirakcTuner, openChannelStream } from './mirakc';
import { chunks } from './stream';

/**
 * 局ロゴを集める。
 *
 * mirakc は Mirakurun と違って**ロゴを TS から集めない**ので、denpa が拾う。
 * 集め方は Mirakurun と同じで、開いているストリームに相乗りする。
 *
 * ロゴは滅多に変わらないうえ、放送波に流れてくるのは数十秒〜数分に一度なので、
 * 録画のついでに拾えたら儲けもの、くらいの扱いにしてある。持っていない局が
 * 残っていれば、空いている時間に短く開いて取りに行く。
 */

/**
 * ロゴを取りに行ける放送。**地上波だけ。**
 *
 * denpa が読んでいるのは CDT (PID 0x0029) で、**衛星はそこにロゴを載せません**。
 * Mirakurun も同じで、ネットワーク4 (BS) は CDT ではなく DSM-CC を読みに行きます
 * (`TSFilter.ts` の `_enableParseDSMCC`)。denpa に DSM-CC の読み手はありません。
 *
 * 実機の数字がそのとおりでした: 地上波は 29/29 局ぶん揃い、**BS は 26中継を
 * 回って 0/38、CS は 12中継を回って 0/54**。開くだけ無駄なので行きません
 * (`BS19_1` のような中継を延々と開いていたのはこれ)。
 */
const CDT_TYPES = new Set(['GR']);

/**
 * 1チャンネルあたりの取得にかける上限。
 *
 * **ロゴ (CDT) は滅多に流れてこない。** 実機で測ると、地上波を100秒読んで
 * 0〜2セクション。分単位で待つ前提のものなので、数十秒開いて諦めていた頃は
 * 当たるほうが偶然でした。3分でも足りず、6分に伸ばしてあります。
 */
const SWEEP_TIMEOUT = 6 * 60_000;
/**
 * 相乗りのときの上限。向こうの都合でいつ閉じてもおかしくないので短くする。
 * こちらはチューナーを増やさない (同じチャンネルなら mirakc が配っているものへ混ぜる)
 */
const RIDE_TIMEOUT = 3 * 60_000;
/**
 * ロゴを取りに行くときの優先度。**web の口から指定できるいちばん下が 0。**
 *
 * −2 を渡しても mirakc は 0 に丸める (実機で確認)。−1 は mirakc が自分の
 * 番組表集めに使う値で、そこへは外から入れない。つまり**優先度では譲れない**。
 *
 * 代わりに `collectingEpg` で譲る。番組表を集めている間はこちらから開かない
 */
const SWEEP_PRIORITY = 0;
/**
 * 画面から取りに行くときに同時に開く地上波の数。
 *
 * 地上波は中継ごとに乗っている局が違うので、1チャンネルずつ3分かけていると
 * 数十チャンネルぶんが何時間もかかる。全部は使わない (録画に残しておく)。
 */
const GROUND_TUNERS = 2;

function logoDir(): string {
    return join(config.dataDir, 'logos');
}

/** サービスIDごとのファイル。mirakc の内部IDをそのまま名前にする */
function logoPath(serviceId: number): string {
    return join(logoDir(), `${serviceId}.png`);
}

export function readLogo(serviceId: number): Uint8Array | null {
    const path = logoPath(serviceId);
    if (!existsSync(path)) return null;
    try {
        return readFileSync(path);
    } catch {
        return null;
    }
}

/**
 * 拾えたロゴを保存して、番組表に出せるようにする。
 *
 * 放送波の service_id は ARIB のもので、denpa が持っている services.id とは
 * 別物。network_id と合わせて引き直す。
 */
function store(networkId: number, serviceIds: number[], data: Uint8Array): number {
    mkdirSync(logoDir(), { recursive: true });

    let saved = 0;
    for (const serviceId of serviceIds) {
        const service = queryAll<{ id: number }>(
            'SELECT id FROM services WHERE network_id = ? AND service_id = ?',
            networkId,
            serviceId,
        );
        for (const { id } of service) {
            // 書きかけを読ませない。番組表は同時に見に来る
            const working = `${logoPath(id)}.writing`;
            writeFileSync(working, data);
            renameSync(working, logoPath(id));
            /*
             * **`updated_at` は触らない。** あれは「最後に mirakc から取り込んだ
             * 時刻」で、番組表は *いちばん新しいものと同じ時刻の局だけ* を出す
             * (`CURRENT_SERVICES`)。ロゴを1局ぶん保存するたびにここを進めていた
             * 頃は、**その局だけが「いまの局」になって番組表から他が消えていた**
             * (次の取り込みまで)。ロゴを拾ったことは取り込みとは何の関係もない
             */
            database().prepare('UPDATE services SET has_logo = 1 WHERE id = ?').run(id);
            saved++;
        }
    }
    return saved;
}

/**
 * 流れてくるTSからロゴを拾う。
 *
 * 失敗しても黙って諦める。ロゴが無くても番組表は出るし、録画には何の関係も無い。
 */
export function watch(networkId: number): (chunk: Uint8Array) => void {
    const collector = new LogoCollector();
    let broken = false;
    /** 同じものを何度も書きに行かない。ロゴは滅多に変わらない */
    const written = new Set<string>();

    return (chunk) => {
        if (broken) return;
        try {
            collector.feed(chunk);
            const found = collector.collected();
            if (found.length === 0) return;

            /*
             * **開いている間は拾い続ける。**
             *
             * 1つ拾った時点で打ち切っていた頃は、1回に1局ぶんしか入らなかった。
             * 1つのTSには**その物理チャンネルに相乗りしている局が全部**流れていて、
             * ロゴも局ごとに別々のタイミングで来る。開いているのはこちらの都合とは
             * 関係なく只なので、来たものは全部取っておく
             */
            let saved = 0;
            for (const { serviceIds, logo } of found) {
                const key = `${logo.logoId}:${logo.logoType}:${logo.logoVersion}`;
                if (written.has(key)) continue;
                written.add(key);
                saved += store(networkId, serviceIds, logo.data);
            }
            if (saved > 0) emit('services');
        } catch (error) {
            console.error(`[logo] 取り込みに失敗しました: ${error}`);
            broken = true;
        }
    };
}

/**
 * `has_logo` を実際のファイルに合わせ直す。
 *
 * この列は「番組表にロゴを出すかどうか」の判断にそのまま使われるので、
 * ファイルが無いのに立っていると番組表に壊れた画像が並ぶ。しかも
 * `missing()` が「もう持っている」とみなして取りに行かなくなるため、
 * 放っておくと永久に埋まらない。実機では32局中29局がこの状態だった。
 *
 * 置き場ごと消えることは実際に起きる (PVCの作り直しなど)。
 * DBとファイルのどちらが正しいかを迷わないよう、**ファイルを正とする**。
 *
 * ついでに、色の表の入っていない古いファイルを直す。放送から拾ったままの
 * PNG はパレットが抜けていて、ブラウザは何も描かない (logo-palette.ts)。
 * 拾い直すと局によっては何時間もかかるので、置いてあるものを直す。
 */
export function reconcile(): number {
    const rows = queryAll<{ id: number; has_logo: number }>('SELECT id, has_logo FROM services');
    const fix = database().prepare('UPDATE services SET has_logo = ? WHERE id = ?');
    let changed = 0;
    const tx = database().transaction(() => {
        for (const row of rows) {
            const actual = existsSync(logoPath(row.id)) ? 1 : 0;
            if (actual === 1) repaint(row.id);
            if (actual === row.has_logo) continue;
            fix.run(actual, row.id);
            changed++;
        }
    });
    tx();
    if (changed > 0) emit('services');
    return changed;
}

/** 置いてある PNG に色の表が入っていなければ入れ直す */
function repaint(serviceId: number): void {
    try {
        const path = logoPath(serviceId);
        const stored = readFileSync(path);
        const fixed = withPalette(stored);
        if (fixed.length === stored.length) return;
        const working = `${path}.writing`;
        writeFileSync(working, fixed);
        renameSync(working, path);
        console.log(`[logo] ${serviceId} の色の表を入れ直しました`);
    } catch {
        // 直せなくても番組表は出る。次の機会に
    }
}

/**
 * ロゴをまだ持っていない局。
 *
 * いま mirakc が知っている局だけを対象にする。取り残しの局まで見に行くと、
 * もう選局できないチャンネルを1局ずつ60秒かけて開いては諦めることになり、
 * 本当に要る局まで順番が回ってこない。
 */
/** ロゴを取りに行く単位。1つの物理チャンネルと、そこに乗っている局 */
export interface Target {
    type: string;
    channel: string;
    network_id: number;
}

/**
 * ロゴを取り直すまでの間隔。
 *
 * **持っていない局だけを見ていた頃は、一度取れたら二度と取り直さなかった。**
 * 局のマークは滅多に変わらないが、変わったときに永久に古いままなのは困る。
 * 取り直しは只ではない (1チャンネルに数分開く) ので、間隔は長めにしておく。
 *
 * **消してから取りに行くのではない。** 来たものを上書きするだけなので、
 * 取れなければ今のものがそのまま残る。番組表からロゴが消えることはない。
 */
const LOGO_MAX_AGE = 7 * 24 * 60 * 60_000;

/** その局のロゴを取りに行く必要があるか。無い、または古い */
function needsLogo(serviceId: number): boolean {
    try {
        return Date.now() - statSync(logoPath(serviceId)).mtimeMs > LOGO_MAX_AGE;
    } catch {
        return true;
    }
}

/** いま mirakc が知っている局。取り残しは見に行かない */
function currentServices(): { id: number; type: string; channel: string; network_id: number }[] {
    return queryAll(
        `SELECT id, type, channel, network_id FROM services
         WHERE ${CURRENT_SERVICES}
         ORDER BY type, channel`,
    );
}

export function missing(): Target[] {
    const targets = new Map<string, Target>();
    for (const service of currentServices()) {
        // 衛星は CDT にロゴを載せない。開いても来ない (CDT_TYPES)
        if (!CDT_TYPES.has(service.type)) continue;
        if (!needsLogo(service.id)) continue;
        const key = `${service.type}:${service.channel}`;
        if (targets.has(key)) continue;
        targets.set(key, { type: service.type, channel: service.channel, network_id: service.network_id });
    }
    return [...targets.values()];
}

/** その物理チャンネルに相乗りしている局のうち、ロゴを取り直したい数 */
function missingOn(channel: string): number {
    return currentServices().filter((s) => s.channel === channel && CDT_TYPES.has(s.type) && needsLogo(s.id))
        .length;
}

/**
 * いま開いて読んでいる物理チャンネル。
 *
 * **相乗り (`ride`) が自分の開けたものに乗らないように持つ。** こちらが開くと
 * mirakc が `tuner.status-changed` を飛ばし、それを合図に相乗りが走って、
 * 同じチャンネルをもう1本開いていた。チューナーは増えないが、同じものを二重に
 * 読むだけで、画面にも同じ中継が2つ並ぶ (実機で `BS01_1` が2つ出ていた)。
 */
const collecting = new Set<string>();

/**
 * 1つの物理チャンネルを開いて、そこに乗っている局のロゴを拾う。
 *
 * **サービス単位では開かない。** mirakc はサービス単位のストリームでは
 * その局に要るPIDだけを通すので、ロゴを載せている CDT (PID 0x0029) は
 * どの局のPMTにも載っていない都合でまるごと落ちる。実機で確かめると、
 * BS をサービス単位で3分・427MB 読んでも CDT は1つも来なかった。
 *
 * **1局取れた時点でも閉じない。** 1つのTSにはその物理チャンネルの局が全部
 * 流れていて、ロゴは局ごとに別々のタイミングで来る。せっかく開いたのだから、
 * 揃うか時間切れになるまで読む。
 */
async function collect(target: Target, timeout: number, signal?: AbortSignal): Promise<number> {
    const before = missingOn(target.channel);
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), timeout);
    collecting.add(target.channel);
    // 外から止められるようにする。衛星に10分かけている最中でも譲れるように
    const give = () => controller.abort();
    signal?.addEventListener('abort', give, { once: true });
    try {
        const stream = await openChannelStream(
            target.type,
            target.channel,
            controller.signal,
            // 何を掴んでいるのかがチューナー画面に出る
            `logo ${target.type}/${target.channel}`,
            SWEEP_PRIORITY,
        );
        const feed = watch(target.network_id);
        for await (const chunk of chunks(stream)) {
            feed(chunk);
            // 全部揃ったら、これ以上開けておく理由がない
            if (missingOn(target.channel) === 0) break;
        }
    } catch {
        // 取れなければ次の機会に。チューナーが空いていないだけのことも多い
    } finally {
        clearTimeout(stop);
        collecting.delete(target.channel);
        signal?.removeEventListener('abort', give);
        controller.abort();
    }
    return before - missingOn(target.channel);
}

/**
 * **その種別を受けられる**空きチューナーの数。無ければ自分では開かない。
 *
 * 種別を見ずに「1本でも空いていれば」で数えていた頃は、地上波のチューナーが
 * 1本しか空いていなくても2チャンネルを同時に開きに行っていた。衛星用の空きは
 * 地上波の役に立たない。
 */
async function freeTuners(type: string): Promise<number> {
    try {
        const tuners = (await getTuners()).filter((tuner) => tuner.types.includes(type as ChannelType));
        // その種別で番組表を集めている間はこちらから開かない (下記)
        if (collectingEpg(tuners)) return 0;
        return tuners.filter((tuner) => tuner.isFree === true).length;
    } catch {
        // mirakc に聞けないなら開きに行かない
        return 0;
    }
}

/**
 * mirakc がいま番組表を集めているか。**渡すのはその種別のチューナーだけ。**
 *
 * **優先度では譲れないので、開くかどうかで譲る。** 番組表集めの優先度は −1 で、
 * web の口から指定できるのは 0 が下限なので、こちらが空きを取ってしまうと
 * あちらが待たされる。ロゴが出なくても番組表は読めるが、番組情報が来なければ
 * 何も予約できない。集めている間はこちらが引く。
 *
 * 衛星のチューナーで集めているからといって地上波まで止める必要はないので、
 * 種別で絞ってから見る。
 *
 * 見分けは掴んでいる相手のID (`job:epg....`)。mirakc 自身の仕事には
 * User-Agent が付かない。
 */
function collectingEpg(tuners: MirakcTuner[]): boolean {
    return tuners.some((tuner) => (tuner.users ?? []).some((user) => user.id.startsWith('job:epg.')));
}

/** いま mirakc が開けている物理チャンネル。選局コマンドから読む */
function openChannels(tuners: MirakcTuner[]): Set<string> {
    const open = new Set<string>();
    for (const tuner of tuners) {
        const channel = tuner.command?.match(/--channel\s+(\S+)/)?.[1];
        if (channel !== undefined) open.add(channel);
    }
    return open;
}

/** 同時に2つ走らせない。相乗りの合図 (tuner.status-changed) は連続して飛んでくる */
let riding = false;

/**
 * 取りに行っている最中の様子。画面はこれを見る。
 *
 * 1チャンネルに数分かける仕事なので、押しても何も起きていないように見えていた。
 * どこまで進んだかを出さないと、動いているのか失敗したのか区別が付かない。
 */
export interface SweepState {
    running: boolean;
    /** いま開いている物理チャンネル。地上波は2つ並ぶ */
    channels: string[];
    /** 見終えた物理チャンネル数と、その総数 */
    done: number;
    total: number;
    /** 拾えた局の数 */
    found: number;
    /** いまの様子、または終わった理由。そのまま画面に出す */
    message: string;
    startedAt: number | null;
    finishedAt: number | null;
}

const IDLE: SweepState = {
    running: false,
    channels: [],
    done: 0,
    total: 0,
    found: 0,
    message: '',
    startedAt: null,
    finishedAt: null,
};

/**
 * 走っているのは高々1つ。定期実行と画面からの「いま取りに行く」が重なると
 * チューナーを食い合う。相乗り (ride) だけは只なので別勘定にしてある
 */
let state: SweepState = IDLE;

export function sweepState(): SweepState {
    return state;
}

function update(patch: Partial<SweepState>): void {
    state = { ...state, ...patch };
    emit('logos');
}

/**
 * 順番に開いて拾う。地上波だけ**同時に2つ**開く。
 *
 * 地上波は中継ごとに乗っている局が違うので、1つずつ回っていると数が捌けない。
 * 衛星は1つの中継で網羅できる代わりに1回が長いので、並べても得が無い。
 *
 * 1つ取りかかるたびに空きを見る。録画が始まったのに開きに行くと、掴めないまま
 * 3分待つことを人数ぶん繰り返すことになる。
 */
async function drain(queue: Target[], parallel: number, signal: AbortSignal): Promise<void> {
    const worker = async () => {
        for (;;) {
            const target = queue.shift();
            if (target === undefined || signal.aborted) return;
            if ((await freeTuners(target.type)) === 0) {
                queue.length = 0;
                update({ message: '空いているチューナーが無くなったので途中でやめました' });
                return;
            }
            update({ channels: [...state.channels, target.channel] });
            const got = await collect(target, SWEEP_TIMEOUT, signal);
            update({
                channels: state.channels.filter((channel) => channel !== target.channel),
                done: state.done + 1,
                found: state.found + got,
            });
        }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
}

/**
 * **いま開いている選局に相乗りして**ロゴを拾う。
 *
 * mirakc は番組表を集めるために自分でチューナーを開く。そこへ同じチャンネルの
 * サービスを要求すると、mirakc は**新しいチューナーを掴まずに配っているものへ混ぜる**
 * ので、こちらは只で電波を読める。空いた時間に自分で開き直すより早く埋まり、
 * チューナーの取り合いも起きない。
 *
 * 合図は `tuner.status-changed`。開いた瞬間に呼ばれるので、閉じるまでの間に読み切る。
 */
export async function ride(): Promise<number> {
    if (riding) return 0;
    riding = true;
    try {
        reconcile();
        const need = missing();
        if (need.length === 0) return 0;

        const open = openChannels(await getTuners());
        if (open.size === 0) return 0;

        let found = 0;
        for (const target of need) {
            if (!open.has(target.channel)) continue;
            // 自分で開けたものには乗らない。同じチャンネルを二重に読むことになる
            if (collecting.has(target.channel)) continue;
            found += await collect(target, RIDE_TIMEOUT);
        }
        return found;
    } catch {
        // mirakc に聞けなければ何もしない。次の知らせでまた来る
        return 0;
    } finally {
        riding = false;
    }
}

/**
 * 定期取得。持っていない局のロゴを少しずつ取りに行く。
 *
 * 分単位で開くので、**空いているチューナーがあるときだけ**にする。優先度は
 * いちばん下 (-2) なので、録画 (2) にも mirakc の番組表集め (-1) にも譲る。
 * 空きが無ければ次の機会に回す。
 *
 * **衛星が埋まるのはこちらだけ。** 画面の「いま取りに行く」は地上波しか見ない
 * (BS/CS はロゴが滅多に流れてこないので、押した人を待たせるだけになる)。
 */
export async function sweep(limit = 1): Promise<number> {
    if (state.running) return 0;
    // 立っているだけでファイルが無い局を先に拾い直す。そうしないと
    // 「もう持っている」とみなして永久に取りに行かない
    reconcile();
    // 開いているチューナーがあるなら、まずそちらに乗る。只で読める
    const ridden = await ride();

    const targets = missing().slice(0, limit);
    if (targets.length === 0 || (await freeTuners(targets[0].type)) === 0) return ridden;
    await run(targets, 1, ridden);
    return state.found;
}

/**
 * 画面の「いま取りに行く」。残っているぶんを、チューナー2つで一気に取りに行く。
 *
 * 対象は定期取得と同じ (`missing`)。衛星は端から入っていない — CDT にロゴが
 * 載らないので、開いても来ない (`CDT_TYPES`)。
 */
export async function sweepGround(): Promise<{ started: boolean; message: string }> {
    /*
     * 定期取得が回っていても譲ってもらう。1チャンネルに6分開くので、
     * 待たせると押した人の用が済まない。只で読める相乗り (ride) は
     * 別勘定なので、ここでは触らない
     */
    if (state.running) {
        inflight?.abort();
        if (!(await settled())) return { started: false, message: 'まだ前の取得が終わっていません' };
    }
    reconcile();
    const targets = missing();
    if (targets.length === 0) {
        return { started: false, message: 'ロゴはもう全部持っています (取り直しも要りません)' };
    }
    /*
     * 開ける本数だけ並べる。**種別まで見る。** 「1本でも空いていれば」で数えて
     * いた頃は、地上波が1本しか空いていなくても2チャンネルを開きに行っていた
     * (衛星用の空きは地上波の役に立たない)
     */
    const free = await freeTuners(targets[0].type);
    if (free === 0) {
        return { started: false, message: '空いているチューナーがありません' };
    }
    const parallel = Math.min(GROUND_TUNERS, free);
    // 終わるのは数分後。押した人を待たせず、進み具合は画面へ流す
    void run(targets, parallel, 0);
    return {
        started: true,
        message:
            `${targets.length} チャンネルぶんを、チューナー ${parallel} 本で取りに行きます。` +
            'ロゴが流れてくるまで数分かかります',
    };
}

/** 走っている取得を外から止めるための口。譲ってもらうときに使う */
let inflight: AbortController | null = null;

/** 止まるのを待つ。開いているストリームを畳むだけなのですぐ終わる */
async function settled(): Promise<boolean> {
    for (let i = 0; i < 50 && state.running; i++) await Bun.sleep(100);
    return !state.running;
}

/** 実際に回すところ。走っている印を立て、終わったら結果を残す */
async function run(targets: Target[], parallel: number, found: number): Promise<void> {
    const controller = new AbortController();
    inflight = controller;
    state = {
        running: true,
        channels: [],
        done: 0,
        total: targets.length,
        found,
        message: '',
        startedAt: Date.now(),
        finishedAt: null,
    };
    emit('logos');
    try {
        await drain([...targets], parallel, controller.signal);
    } finally {
        inflight = null;
        const left = missing().length;
        update({
            running: false,
            channels: [],
            finishedAt: Date.now(),
            message:
                state.message !== ''
                    ? state.message
                    : `${state.found} 局ぶん拾いました (まだ持っていないチャンネルは残り ${left})`,
        });
        if (state.found > 0) console.log(`[logo] ${state.message}`);
        emit('services');
    }
}

/**
 * 何局ぶん持っているか。「本当に取れているのか」を画面で確かめられるように。
 *
 * **数えるのは取りに行ける放送だけ** (地上波)。衛星まで分母に入れていた頃は、
 * 地上波が全部揃っていても「29 / 124 局」と出て、ずっと足りていないように
 * 見えていた。取りに行けないものを数えても仕方がない。
 *
 * `pending` はこれから取りに行く物理チャンネルの数。0 なら押す口を出さない。
 */
export function stats(): { have: number; total: number; pending: number } {
    const services = currentServices().filter((service) => CDT_TYPES.has(service.type));
    return {
        have: services.filter((service) => existsSync(logoPath(service.id))).length,
        total: services.length,
        pending: missing().length,
    };
}
