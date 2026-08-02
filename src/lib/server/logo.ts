import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LogoCollector } from '../ts/logo';
import { config } from './config';
import { database, now, queryAll, queryOne } from './db';
import { CURRENT_SERVICES } from './epg';
import { emit } from './events';
import { getTuners, type MirakcTuner, openServiceStream } from './mirakc';
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

/** 1局あたりの取得にかける上限。長く開くとチューナーを塞ぐ */
const SWEEP_TIMEOUT = 60_000;
/**
 * 相乗りのときの上限。向こうの都合でいつ閉じてもおかしくないので短くする。
 * ロゴは数十秒に一度流れてくるので、拾えるときはこの中で拾える
 */
const RIDE_TIMEOUT = 30_000;
/** ロゴを取りに行くときの優先度。録画より低くして、必要なら奪われるようにする */
const SWEEP_PRIORITY = 0;

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
            database()
                .prepare('UPDATE services SET has_logo = 1, updated_at = ? WHERE id = ?')
                .run(now(), id);
            saved++;
        }
    }
    return saved;
}

/**
 * ストリームに相乗りしてロゴを拾う。
 *
 * 録画の本流を邪魔しないよう、失敗しても黙って諦める。ロゴが無くても
 * 番組表は出るし、録画には何の関係も無い。
 */
export function watch(serviceId: number): (chunk: Uint8Array) => void {
    const collector = new LogoCollector();
    // 放送波の service_id は ARIB のもので、denpa の services.id とは別物。
    // どのネットワークの話かはこちらが知っている
    const service = queryOne<{ network_id: number }>(
        'SELECT network_id FROM services WHERE id = ?',
        serviceId,
    );
    let broken = service === undefined;
    /** 同じものを何度も書きに行かない。ロゴは滅多に変わらない */
    const written = new Set<string>();

    return (chunk) => {
        if (broken) return;
        try {
            collector.feed(chunk);
            const found = collector.collected();
            if (found.length === 0) return;

            /*
             * **チューナーが開いている間は拾い続ける。**
             *
             * 1つ拾った時点で打ち切っていた頃は、1本の録画で1局ぶんしか入らなかった。
             * 1つのTSには**その物理チャンネルに相乗りしている局が全部**流れていて、
             * ロゴも局ごとに別々のタイミングで来る。開いているのはこちらの都合とは
             * 関係なく只なので、来たものは全部取っておく
             */
            let saved = 0;
            for (const { serviceIds, logo } of found) {
                const key = `${logo.logoId}:${logo.logoType}:${logo.logoVersion}`;
                if (written.has(key)) continue;
                written.add(key);
                saved += store(service!.network_id, serviceIds, logo.data);
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
 */
export function reconcile(): number {
    const rows = queryAll<{ id: number; has_logo: number }>('SELECT id, has_logo FROM services');
    const fix = database().prepare('UPDATE services SET has_logo = ? WHERE id = ?');
    let changed = 0;
    const tx = database().transaction(() => {
        for (const row of rows) {
            const actual = existsSync(logoPath(row.id)) ? 1 : 0;
            if (actual === row.has_logo) continue;
            fix.run(actual, row.id);
            changed++;
        }
    });
    tx();
    if (changed > 0) emit('services');
    return changed;
}

/**
 * ロゴをまだ持っていない局。
 *
 * いま mirakc が知っている局だけを対象にする。取り残しの局まで見に行くと、
 * もう選局できないチャンネルを1局ずつ60秒かけて開いては諦めることになり、
 * 本当に要る局まで順番が回ってこない。
 */
export function missing(): { id: number; network_id: number; name: string; channel: string }[] {
    return queryAll<{ id: number; network_id: number; name: string; channel: string }>(
        `SELECT id, network_id, name, channel FROM services
         WHERE has_logo = 0 AND ${CURRENT_SERVICES}
         ORDER BY type, channel, service_id`,
    );
}

/** その物理チャンネルに相乗りしている局のうち、まだロゴを持っていないもの */
function missingOn(channel: string): number[] {
    return queryAll<{ id: number }>(
        `SELECT id FROM services WHERE channel = ? AND has_logo = 0 AND ${CURRENT_SERVICES}`,
        channel,
    ).map((row) => row.id);
}

/**
 * 1つの物理チャンネルを開いて、そこに乗っている局のロゴを拾う。
 *
 * **1局取れた時点では閉じない。** 1つのTSにはその物理チャンネルの局が全部
 * 流れていて、ロゴは局ごとに別々のタイミングで来る。せっかく開いたのだから、
 * 揃うか時間切れになるまで読む。
 */
async function collect(channel: string, serviceId: number, timeout: number): Promise<number> {
    const before = missingOn(channel).length;
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), timeout);
    try {
        const stream = await openServiceStream(serviceId, controller.signal, SWEEP_PRIORITY);
        const feed = watch(serviceId);
        for await (const chunk of chunks(stream)) {
            feed(chunk);
            // 全部揃ったら、これ以上開けておく理由がない
            if (missingOn(channel).length === 0) break;
        }
    } catch {
        // 取れなければ次の機会に。チューナーが空いていないだけのことも多い
    } finally {
        clearTimeout(stop);
        controller.abort();
    }
    return before - missingOn(channel).length;
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

        /*
         * 開いているチャンネルごとに1回だけ乗る。同じチャンネルの局を
         * 1つずつ開き直しても、読むものは同じ1本のTSでしかない
         */
        let found = 0;
        const done = new Set<string>();
        for (const service of need) {
            if (!open.has(service.channel) || done.has(service.channel)) continue;
            done.add(service.channel);
            found += await collect(service.channel, service.id, RIDE_TIMEOUT);
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
 * 持っていない局のロゴを取りに行く。
 *
 * 録画と同じ口を短く開くだけ。優先度を下げてあるので、チューナーが足りなければ
 * mirakc が録画のほうを通す。
 */
export async function sweep(limit = 1): Promise<number> {
    // 立っているだけでファイルが無い局を先に拾い直す。そうしないと
    // 「もう持っている」とみなして永久に取りに行かない
    reconcile();
    // 開いているチューナーがあるなら、まずそちらに乗る。只で読める
    let found = await ride();
    // 自分で開くのは1チャンネルずつ。長く掴むと録画に響く
    const channels = [...new Set(missing().map((service) => service.channel))].slice(0, limit);
    for (const channel of channels) {
        const service = missing().find((row) => row.channel === channel);
        if (service !== undefined) found += await collect(channel, service.id, SWEEP_TIMEOUT);
    }
    return found;
}
