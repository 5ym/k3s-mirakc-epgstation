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
 * 地上波を1チャンネル開いておく上限。
 *
 * **ロゴは滅多に流れてこない。** 実機で測ると、地上波 (CDT) を100秒読んで
 * 0〜2セクション。分単位で待つ前提のものなので、数十秒開いて諦めていた頃は
 * 当たるほうが偶然でした。3分でも足りず、6分に伸ばしてあります。
 */
const SWEEP_TIMEOUT = 6 * 60_000;

/**
 * 衛星を1チャンネル開いておく上限。**地上波よりずっと長い。**
 *
 * 衛星のカルーセルは流しっぱなしではなく、**まとまって来て、あとは無音**。
 * 実機の `BS15_0` を15分読み続けて測ると、13分間はロゴのESに1パケットも
 * 流れず、14分目にまとめて来た (BS 2768・CS 8224 パケット)。
 * 6分で諦めていた頃は、当たるかどうかが運任せでした。
 *
 * 当たりの中継はここまで待つ価値がある — 一度当たれば**BS と CS の全局**が
 * まとめて手に入る。外れの中継は PAT を見た時点 (1秒ほど) で切り上げるので、
 * この長さを待たされるのは当たりの1中継だけ。
 */
const SATELLITE_TIMEOUT = 20 * 60_000;

/**
 * 衛星で「もう来ない」とみなすまでの静けさ。
 *
 * **「この中継ぶんが揃ったら閉じる」では決められない。** カルーセルには BS と CS の
 * 全局が載っているが、そのうち何局ぶんが載っているのかは開く前には分からない。
 * 「衛星でまだ持っていない局が0になるまで」で待つと、放送側が流していない局
 * (実機の CS の一部) が1つでもあると**毎回20分丸ごと待つ**ことになる。
 *
 * まとまって来て、あとは無音、という流れ方をするので、**最後に1局拾ってから
 * これだけ何も来なければ切り上げる**。実測ではカルーセル1回ぶんが同じ1分の中に
 * 収まっていたので、これだけ空けば取りこぼしはない。
 */
const SATELLITE_QUIET = 15_000;
/**
 * 相乗りのときの上限。向こうの都合でいつ閉じてもおかしくないので短くする。
 * こちらはチューナーを増やさない (同じチャンネルなら mirakc が配っているものへ混ぜる)
 *
 * **実際に集めているのはほぼこちら。** 実機では、BS の38局ぶんが mirakc の
 * 局調べに相乗りした一度で全部揃った (denpa が自分でチューナーを開いた記録は
 * 残っていない)。mirakc は番組表と局を集めるために全チャンネルを定期的に
 * 開くので、こちらはそこに乗っているだけで只で埋まる。
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
 * 画面から取りに行くときに同時に開く数。
 *
 * 地上波は中継ごとに乗っている局が違うので、1チャンネルずつ数分かけていると
 * 数十チャンネルぶんが何時間もかかる。全部は使わない (録画に残しておく)。
 */
const SWEEP_TUNERS = 2;

/**
 * ロゴのカルーセルが載っていない中継を、次に確かめ直すまでの間隔。
 *
 * **衛星のロゴは中継1つにしか載っていない。** 実機の BS はネットワーク4の
 * 26中継のうち `BS15_0` だけで、そこにエンジニアリングサービス (929) が居る。
 * **CS の12中継には1つも居ません** — CS のロゴもこの BS の中継から降ってきます
 * (`CS_LOGO-05`)。つまり CS の物理チャンネルは開くだけ無駄。
 *
 * 覚えておかないと、見回りのたびに CS の12中継を開き直すことになる。
 * 放送側の都合はいつか変わるので、間隔を空けて確かめ直す。
 */
const RELAY_RETRY = 7 * 24 * 60 * 60_000;

function logoDir(): string {
    return join(config.dataDir, 'logos');
}

/** サービスIDごとのファイル。mirakc の内部IDをそのまま名前にする */
function logoPath(serviceId: number): string {
    return join(logoDir(), `${serviceId}.png`);
}

/**
 * ロゴを流していないと分かった中継の控え。
 *
 * ロゴの置き場に置く。DBに列を足さないのは、ロゴまわりは**ファイルを正**と
 * 決めてあるため (`reconcile`)。置き場ごと消えたら、また調べ直せばいい。
 */
function relayPath(): string {
    return join(logoDir(), 'satellite-relays.json');
}

interface RelayNotes {
    /** ロゴを積んでいなかった中継と、そう分かった時刻 */
    noCarousel: Record<string, number>;
    /** カルーセルを読み切っても来なかった局 (局ID → そう分かった時刻) */
    absent: Record<string, number>;
}

/**
 * 読んだ控えを持っておく。
 *
 * `missing()` は局の数だけ引くので (実機で124局)、そのたびにファイルを
 * 読みに行くと、番組表を1回出すだけで何百回も開くことになる。
 * 書くのはこの1プロセスだけなので、書いたときに入れ替えれば足りる
 */
let relays: RelayNotes | null = null;

function notes(): RelayNotes {
    if (relays !== null) return relays;
    try {
        const parsed = JSON.parse(readFileSync(relayPath(), 'utf8')) as Partial<RelayNotes>;
        relays = { noCarousel: parsed.noCarousel ?? {}, absent: parsed.absent ?? {} };
    } catch {
        relays = { noCarousel: {}, absent: {} };
    }
    return relays;
}

function save(next: RelayNotes): void {
    relays = next;
    try {
        mkdirSync(logoDir(), { recursive: true });
        const working = `${relayPath()}.writing`;
        writeFileSync(working, JSON.stringify(next));
        renameSync(working, relayPath());
    } catch {
        // 控えられなくても集めることはできる。次の機会に
    }
}

/** その中継は今回は飛ばしてよいか。確かめてから RELAY_RETRY の間だけ */
function skipRelay(channel: string): boolean {
    const at = notes().noCarousel[channel];
    return at !== undefined && Date.now() - at < RELAY_RETRY;
}

/** 「この中継にロゴは載っていない」/「載っていた」を書き留める */
function markRelay(channel: string, hasLogo: boolean): void {
    const known = notes();
    // 何も変わらないなら書きに行かない (1チャンクごとに呼ばれる道がある)
    if (hasLogo === (known.noCarousel[channel] === undefined)) return;
    const noCarousel = { ...known.noCarousel };
    if (hasLogo) delete noCarousel[channel];
    else noCarousel[channel] = Date.now();
    save({ ...known, noCarousel });
}

/**
 * カルーセルを1回ぶん読み切った。**まだ埋まらない局を控える。**
 *
 * カルーセルには BS も CS もまとめて載っているので、読み切ってなお来ない局は
 * そもそも載っていない。中継ごとの当たり外れ (`noCarousel`) とは別の話で、
 * 混ぜると**「CS の中継にロゴが無い」=「CS のロゴは取れない」**という誤りになる
 * (CS のロゴは BS の中継から降ってくる)。
 *
 * **局ごとに控える。** 「読み切った時刻」だけを控えていた頃は、そのあと衛星の
 * ロゴを1つ消しても1週間は取りに行かなかった。局で持てば、消えたぶんは
 * 「控えに無い = まだ取れるはず」になって自然に取りに行く。
 */
function markAbsent(): void {
    const known = notes();
    const absent = { ...known.absent };
    for (const service of currentServices()) {
        if (service.type !== 'GR' && needsLogo(service.id)) absent[service.id] = Date.now();
    }
    save({ ...known, absent });
}

/** その局はカルーセルに載っていないと分かっているか */
function absentFromCarousel(serviceId: number): boolean {
    const at = notes().absent[serviceId];
    return at !== undefined && Date.now() - at < LOGO_MAX_AGE;
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
export function watch(networkId: number): Feed {
    const collector = new LogoCollector(networkId);
    let broken = false;
    /** 同じものを何度も書きに行かない。ロゴは滅多に変わらない */
    const written = new Set<string>();

    const feed = (chunk: Uint8Array) => {
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
            for (const { networkId: network, serviceIds, logo } of found) {
                // 衛星は他ネットワークの局も混ざる。どのネットワークのぶんかは
                // ロゴ自身が知っているので、そちらで引く
                const key = `${network}:${logo.logoId}:${logo.logoType}:${logo.logoVersion}`;
                if (written.has(key)) continue;
                written.add(key);
                saved += store(network, serviceIds, logo.data);
            }
            if (saved > 0) emit('services');
        } catch (error) {
            console.error(`[logo] 取り込みに失敗しました: ${error}`);
            broken = true;
        }
    };
    /** 外れの中継を早く見切るために覗く。地上波では使わない */
    Object.defineProperty(feed, 'hasSatelliteLogo', { get: () => collector.hasSatelliteLogo });
    return feed as Feed;
}

/** 食わせる口。ついでに「この中継にロゴがあるか」を覗ける */
export interface Feed {
    (chunk: Uint8Array): void;
    readonly hasSatelliteLogo: boolean | null;
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
    const services = currentServices();
    const targets = new Map<string, Target>();
    const add = (service: { type: string; channel: string; network_id: number }) => {
        const key = `${service.type}:${service.channel}`;
        if (targets.has(key)) return;
        targets.set(key, { type: service.type, channel: service.channel, network_id: service.network_id });
    };

    // 地上波は中継ごとに乗っている局が違う。その中継の局が足りないときだけ開く
    for (const service of services) {
        if (service.type === 'GR' && needsLogo(service.id)) add(service);
    }

    /*
     * **衛星は「その中継の局が足りているか」では選べない。**
     *
     * ロゴを積んだ中継1つに BS も CS も全部載っているので、中継ごとに見ると
     * BS が揃った時点でその中継が候補から外れ、**そこにしか無い CS が永久に
     * 埋まらない**。実機ではこれで BS 38/38・CS 0/54 のまま止まっていた。
     *
     * 衛星の局が1つでも足りなければ、**まだ外れと分かっていない中継**を当たる。
     * どれが当たりかは開いてみないと分からないが (実機の BS はネットワーク4の
     * 26中継のうち `BS15_0` だけ)、外れは PAT を見た時点で1秒ほどで切り上げ、
     * 書き留めて二度目からは飛ばす (`collect` / `markRelay`)。
     *
     * ただし**カルーセルに載っていないと分かっている局は数に入れない**。
     * 読み切ってなお来なかった局は行っても来ないので、そこだけを理由に
     * 中継を開き直すと同じことの繰り返しになる
     */
    if (missingSatellites() > 0) {
        for (const service of services) {
            if (service.type !== 'GR' && !skipRelay(service.channel)) add(service);
        }
    }
    return [...targets.values()];
}

/** その物理チャンネルに相乗りしている局のうち、ロゴを取り直したい数 */
function missingOn(channel: string): number {
    return currentServices().filter((s) => s.channel === channel && needsLogo(s.id)).length;
}

/**
 * 衛星でまだ取れていない局の数。
 *
 * **衛星のカルーセルは開いた中継の局だけを運ぶのではない。** `BS15_0` の
 * エンジニアリングサービスには `LOGO-05` と `CS_LOGO-05` が並んで流れていて、
 * **BS と CS の全局ぶん**が入っている。
 *
 * 「開いた中継の局が揃ったら閉じる」で見ていた頃は、先に来る BS のぶんで
 * 条件が満たされて即座に閉じてしまい、同じカルーセルの後ろに続く CS の
 * ぶんを毎回取りこぼしていた (実機で CS が 0/54 のままだった)。
 */
function missingSatellites(): number {
    return currentServices().filter((s) => s.type !== 'GR' && needsLogo(s.id) && !absentFromCarousel(s.id))
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
    const before = target.type !== 'GR' ? missingSatellites() : missingOn(target.channel);
    /** 当たり外れを書き留めたか。毎回書きに行かないための印 */
    let marked = false;
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
        const satellite = target.type !== 'GR';
        let left = before;
        let progressed = Date.now();
        for await (const chunk of chunks(stream)) {
            feed(chunk);
            /*
             * **衛星は「開いた中継の局」では見ない。** 同じカルーセルに BS と CS の
             * 全局ぶんが入っているので、開いた中継のぶんで打ち切ると後ろに続く
             * CS を毎回取りこぼす (実機で CS が 0/54 のままだった原因)
             */
            const now = satellite ? missingSatellites() : missingOn(target.channel);
            if (now < left) {
                left = now;
                progressed = Date.now();
            }
            // 全部揃ったら、これ以上開けておく理由がない
            if (now === 0) {
                if (satellite) markAbsent();
                break;
            }
            /*
             * 衛星は揃いきらないことがある (カルーセルに載っていない局がある)。
             * 拾えたあと何も来なくなったら、そこで切り上げる。これが無いと
             * 載っていない局が1つでもあるだけで毎回20分丸ごと待つことになる。
             *
             * ここまで来たなら**カルーセルは1回ぶん読み切った**。残っている局は
             * 載っていない局なので、そう書き留めて次からは行かない
             */
            if (satellite && left < before && Date.now() - progressed > SATELLITE_QUIET) {
                markAbsent();
                break;
            }
            /*
             * **衛星のロゴは1つの中継にしかない。** 実機の BS はネットワーク4に
             * 26の中継があるが、ロゴを運ぶエンジニアリングサービス (929) が
             * 居るのは `BS15_0` (NHK BS と同じ中継) だけだった。CS の12中継には
             * どこにも居ない (CS のロゴもこの BS の中継から流れてくる)。
             * 外れの中継は PAT を見た時点で分かるので、待たずに次へ行く。
             *
             * 当たり外れは書き留めておく。そうしないと、二度と来ないものを
             * 見回りのたびに開き直すことになる
             */
            if (satellite && !marked && feed.hasSatelliteLogo !== null) {
                marked = true;
                markRelay(target.channel, feed.hasSatelliteLogo);
                if (!feed.hasSatelliteLogo) break;
            }
        }
    } catch {
        // 取れなければ次の機会に。チューナーが空いていないだけのことも多い
    } finally {
        clearTimeout(stop);
        collecting.delete(target.channel);
        signal?.removeEventListener('abort', give);
        controller.abort();
    }
    // 衛星は開いた中継以外の局も一緒に拾える。数えるほうも合わせる
    return before - (target.type !== 'GR' ? missingSatellites() : missingOn(target.channel));
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
 * 順番に開いて拾う。**同時に2つまで。**
 *
 * 地上波は中継ごとに乗っている局が違うので、1つずつ回っていると数が捌けない。
 * 衛星は当たりの中継1つで全局ぶんが揃う代わりに1回が長い。
 *
 * 1つ取りかかるたびに空きを見る。録画が始まったのに開きに行くと、掴めないまま
 * 待つことを人数ぶん繰り返すことになる。
 */
async function drain(queue: Target[], parallel: number, signal: AbortSignal): Promise<void> {
    /** 空きが無くなった種別。**その種別だけ**諦める (衛星の満杯で地上波を止めない) */
    const full = new Set<string>();
    const worker = async () => {
        for (;;) {
            const target = queue.shift();
            if (target === undefined || signal.aborted) return;
            // 諦めたぶんも見終えたものとして数える。進み具合が総数に届かなくなる
            if (full.has(target.type)) {
                update({ done: state.done + 1 });
                continue;
            }
            if ((await freeTuners(target.type)) === 0) {
                full.add(target.type);
                update({
                    done: state.done + 1,
                    message: `${target.type} の空きチューナーが無くなったので、そのぶんはやめました`,
                });
                continue;
            }
            update({ channels: [...state.channels, target.channel] });
            // 衛星のカルーセルは十数分に一度しか来ない。当たりの中継はそれまで待つ
            const limit = target.type === 'GR' ? SWEEP_TIMEOUT : SATELLITE_TIMEOUT;
            const got = await collect(target, limit, signal);
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
 * 定期の見回り。**相乗りだけで、自分ではチューナーを開かない。**
 *
 * mirakc は番組表と局を調べるために全チャンネルを定期的に開く。その選局へ
 * 混ぜてもらえば只で読めるので、**実際に集まっているのはほぼこちら**だった。
 * 実機で確かめると、BS の38局ぶんは mirakc の局調べに相乗りした一度で全部
 * 揃っていて、denpa が自分でチューナーを開いて拾えた記録は残っていない。
 *
 * 自分でも開いていた頃は、10分ごとに1チャンネルを数分掴んでいた。相乗りで
 * 埋まるのに録画とチューナーを取り合う理由がないので、定期のぶんはやめた。
 * すぐ欲しいときは画面の「いま取りに行く」(`sweepNow`) がある。
 */
export async function sweep(): Promise<number> {
    // 立っているだけでファイルが無い局を先に拾い直す。そうしないと
    // 「もう持っている」とみなして永久に取りに行かない
    reconcile();
    return ride();
}

/**
 * 画面の「いま取りに行く」。残っているぶんを、チューナー2つで一気に取りに行く。
 *
 * **衛星も混ぜる。** ロゴを運ぶ中継は1つだけで、当たれば BS と CS の全局ぶんが
 * まとめて揃い、外れは PAT を見た時点 (1秒ほど) で次へ行く。当たり外れを
 * 書き留めておくので、二度目からは当たりの中継しか開かない。
 */
export async function sweepNow(): Promise<{ started: boolean; message: string }> {
    /*
     * 前の取得が回っていても譲ってもらう。1チャンネルに数分〜20分開くので、
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
     * 空きは**種別ごとに数える。** 衛星用の空きは地上波の役に立たない。
     * 「1本でも空いていれば」で数えていた頃は、地上波が1本しか空いていなくても
     * 2チャンネルを開きに行っていた
     */
    const free = new Map<string, number>();
    for (const type of new Set(targets.map((target) => target.type))) {
        free.set(type, await freeTuners(type));
    }
    if ([...free.values()].every((count) => count === 0)) {
        return { started: false, message: '空いているチューナーがありません' };
    }
    // 地上波を先に回す。中継ごとに違う局が乗っているので、数が捌けるのはこちら
    const ordered = [...targets].sort((a, b) => Number(b.type === 'GR') - Number(a.type === 'GR'));
    const parallel = Math.min(SWEEP_TUNERS, Math.max(...free.values()));
    // 終わるのは数分後。押した人を待たせず、進み具合は画面へ流す
    void run(ordered, parallel, 0);
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
 * `pending` はこれから取りに行く物理チャンネルの数。0 なら押す口を出さない。
 *
 * `unavailable` は**カルーセルに載っていないので取れない**衛星の局の数。
 * 数えておかないと「N局ぶん足りない」という表示が永久に残り、こちらの不具合と
 * 見分けが付かない。
 *
 * **中継にロゴが無いこと (`skipRelay`) では数えない。** CS の12中継にはロゴの
 * カルーセルが無いが、CS のロゴは BS の中継から降ってくるので、中継で数えると
 * 取れる局まで「取れません」と出てしまう (実際そう出していた)。
 * カルーセルを読み切った後になお足りない局だけが、本当に取れない局。
 */
export function stats(): { have: number; total: number; pending: number; unavailable: number } {
    const services = currentServices();
    const has = (service: { id: number }) => existsSync(logoPath(service.id));
    return {
        have: services.filter(has).length,
        total: services.length,
        pending: missing().length,
        unavailable: services.filter((service) => !has(service) && absentFromCarousel(service.id)).length,
    };
}
