import { mkdirSync } from 'node:fs';
import { SOCKET_PATH } from '$lib/live';
import { listen } from './agent-events';
import { ensureBasicAuth } from './auth';
import { config } from './config';
import { pump, requeueOrphanedJobs } from './encoder';
import { sync, syncServicesOnly } from './epg';
import { collectOnce } from './epg-collect';
import { emit } from './events';
import { pruneHistory, reconcile } from './files';
import { attend } from './live';
import { reconcile as logoReconcile, ride, sweep } from './logo';
import { sweep as learnSweep } from './logo-learn';
import { activeRecordingIds, recoverOrphanedRecordings } from './recorder';
import { tick } from './scheduler';
import { prune as pruneSessions } from './session';
import { beginDraining } from './shutdown';
import { redeem } from './tickets';
import { serve } from './ws';

let started = false;
const timers: ReturnType<typeof setInterval>[] = [];
let unlisten: (() => void) | null = null;

async function guard(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
    try {
        await fn();
    } catch (error) {
        // ループを止めないことが最優先。次の周回で自然に復帰する
        console.error(`[${name}] ${error}`);
    }
}

function every(ms: number, name: string, fn: () => Promise<unknown> | unknown): void {
    const timer = setInterval(() => void guard(name, fn), ms);
    // このタイマーがイベントループを掴んだままにする必要はない
    timer.unref?.();
    timers.push(timer);
}

export function start(): void {
    if (started) return;
    started = true;

    mkdirSync(config.recordedDir, { recursive: true });
    mkdirSync(config.libraryDir, { recursive: true });

    /*
     * **鍵を掛けてから開ける。** 何も設定しないまま立てると、録画も WebDAV も
     * 誰でも取れる状態で上がっていた。無ければここで作る (作ったら1度だけログに出す)。
     *
     * バックグラウンド処理より先にやる — `DENPA_AUTOSTART=0` でも掛かっていないと
     * 意味が無い
     */
    ensureBasicAuth();

    /*
     * **ライブ視聴の受け口を開ける。** ここは `DENPA_AUTOSTART=0` でも開ける —
     * 押されたときだけ動くもので、勝手にチューナーを掴みはしない。
     *
     * 認証は使い捨ての札で見る。ブラウザは WebSocket の握手に `Authorization` を
     * 付けてくれないので、画面が先に `/api/live/ticket` から取ってくる (`tickets.ts`)
     */
    serve(SOCKET_PATH, {
        // **握手より前に見る。** ここで断れば普通の HTTP で理由を返せる
        accept: (url) => redeem(url.searchParams.get('ticket')),
        open: (connection) => attend(connection),
    });

    const recovered = recoverOrphanedRecordings();
    const orphanedJobs = requeueOrphanedJobs();
    if (recovered.resumed > 0 || recovered.failed > 0 || orphanedJobs > 0) {
        console.log(
            `[boot] 前回の異常終了を回収: 録画 ${recovered.resumed} 件を再開 / ` +
                `${recovered.failed} 件を失敗扱い / エンコード ${orphanedJobs} 件を再投入`,
        );
    }
    installShutdownHooks();

    if (!config.autostart) {
        console.log('[boot] DENPA_AUTOSTART=0 のためバックグラウンド処理は起動しません');
        return;
    }

    /*
     * 局を取り込んで、溜まっている番組表で予約を組み直す。
     * 局の一覧はエージェントが持っている (スキャンの結果) ので、そこから取る
     */
    void guard('epg', sync);
    every(config.channelSyncInterval, 'services', syncServicesOnly);

    /*
     * **番組表を自分で集める。**
     * チューナーが空いているだけ並列に回し、薄い局から先に行く (epg-collect.ts)。
     * 起動直後に1回走らせるので、初回は数分で番組表が出る
     */
    void guard('epg-collect', collectOnce);
    every(config.epgCollectInterval, 'epg-collect', collectOnce);

    listenToAgent();

    every(config.schedulerTick, 'scheduler', async () => {
        await tick();
        pump();
    });

    /*
     * 実体とDBを突き合わせ、外から消されたものを一覧から落とす。
     *
     * inotify (fs.watch) で消した瞬間に拾えないか試したが、この構成では
     * 最初の1件しかイベントが来ず当てにできなかったので定期実行にしてある。
     * すぐ反映したいときは画面の「実体と照合」を押す。
     */
    void guard('reconcile', reconcile);
    every(config.reconcileInterval, 'reconcile', reconcile);

    /*
     * 古い履歴を畳む。終わった予約と、消した録画の行が対象。
     * 実体はもう無いので、消えて困るものはない。照合と同じ周期でよい
     */
    void guard('prune', pruneHistory);
    every(config.reconcileInterval, 'prune', pruneHistory);

    /*
     * 切れたログインの控えを片付ける。**入れなくなる人は居ません** — 切れたものは
     * 読む側 (`session.find`) が既に無視しているので、消しているのは行だけ
     */
    void guard('sessions', pruneSessions);
    every(config.reconcileInterval, 'sessions', pruneSessions);

    /*
     * 局ロゴ。放送波から拾うしかないので、持っていない局のぶんを少しずつ取りに行く。
     * 開いている選局に相乗りするだけなので、チューナーは増えない
     *
     * 起動のたびに、印 (`has_logo`) とファイルを突き合わせ直す。置き場ごと
     * 消えることは実際にあり、印だけ残っていると番組表に壊れた画像が並ぶ
     */
    void guard('logo', async () => {
        logoReconcile();
    });
    every(config.logoSweepInterval, 'logo', async () => {
        await sweep();
    });

    /*
     * CM検出のロゴを**録画より先に**覚えておく (logo-learn.ts)。
     *
     * これまではエンコードのときに覚えていたので、局ごとに1本目だけ精度が
     * 落ちていた。空いているチューナーがあるときだけ、1局につき数分掴む。
     * 録画にも番組表にも譲る (優先度はロゴ集めと同じでいちばん下)
     */
    every(config.logoLearnInterval, 'logo-learn', async () => {
        await learnSweep();
    });
}

/**
 * エージェントからの知らせを受け取る。
 *
 * チューナーの様子もスキャンの進み具合も、これまでは決まった間隔で覗きに行っていた。
 * 覗きに行く方式だと「変わってから気付くまで」が必ず空くうえ、
 * 何も変わっていない時間帯も同じだけ叩くことになる。
 *
 * 上の定期実行は残してある。知らせは繋ぎ直しはするものの、黙って止まる
 * 可能性まで消せるわけではないので、保険として置いておく。
 */
function listenToAgent(): void {
    unlisten = listen((event) => {
        switch (event.name) {
            case 'tuners':
                emit('tuners');
                /*
                 * 誰かがチューナーを開いた、かもしれない。そこへ同じチャンネルを
                 * 要求するとエージェントが相乗りさせるので、ロゴを只で読める。
                 * 開いた瞬間に来る知らせなので、ここで乗る
                 */
                void guard('logo', ride);
                break;
            case 'channels':
                // スキャンで局が入れ替わった。取り込み直して番組表も集め直す
                void guard('epg', async () => {
                    await sync();
                    await collectOnce();
                });
                break;
            default:
                break;
        }
    });
}

export function stop(): void {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    unlisten?.();
    unlisten = null;
    started = false;
}

/**
 * Pod の入れ替えなどで止められたときの後始末。
 *
 * **録画中は、終わるまで居座ってから止まる。** 追記で開いているので落ちても
 * 次の起動で続きから録れるが、入れ替わるまでの十数秒はどうやっても落ちる。
 * ArgoCD の同期は待てるが、放送は待ってくれない。
 *
 * 待っている間は新しい録画を始めない (`beginDraining`)。始めてしまうと
 * いつまでも終わらないため。エンコードは待たない (再起動でやり直せる)。
 *
 * 待つのをやめる上限が `SHUTDOWN_WAIT`。0 にすると今までどおりすぐ止まる。
 * **Kubernetes 側の `terminationGracePeriodSeconds` と docker compose の
 * `stop_grace_period` を、これ以上に伸ばしておくこと。** 伸ばさないと、
 * 待っている途中で SIGKILL され、居座った意味が無くなる。
 */
function installShutdownHooks(): void {
    /*
     * **落ちても降りる。** `drain` の中で投げると、`void` で捨てているぶん
     * 誰も拾わず、**プロセスが生きたまま残る** = 入れ替えが止まる。
     * 拾って、掴んでいるものだけ放して降りる
     */
    const onSignal = (signal: NodeJS.Signals) => {
        drain(signal).catch((error) => {
            console.warn(`[boot] 停止の途中で失敗しました: ${error}`);
            process.exit(0);
        });
    };
    const take = () => takeOverSignals(onSignal);
    take();
    /*
     * **もう一度、あとから引き取り直す。**
     *
     * adapter-node が後始末を登録するのは `build/index.js` の**いちばん最後**で、
     * こちらはその手前 (`hooks.server.ts` はアプリの読み込みで走る) なので、
     * **最初の引き取りでは外すものがまだ無い**。そのまま置くと両方が登録された
     * 状態になり、SIGTERM で
     *
     * - こちら … 録画が終わるまで待つ
     * - あちら … `httpServer.close()` で listen を閉じる
     *
     * が同時に走る。プロセスは生きたまま**ポートだけ閉じる**ので、録画は
     * 続いているのに画面がどこからも開けない (実機で確認: プロセスは動いて
     * 番組表も集めているのに `/proc/net/tcp` に listen が1つも無く、
     * Traefik は「no available server」)。
     *
     * `setImmediate` なら index.js の残りが走り終えたあとになる。
     */
    setImmediate(() => {
        const taken = take();
        if (taken > 0) console.log(`[boot] 止まれの合図を引き取りました (${taken} 件)`);
    });
}

/**
 * 止まれの合図を**こちらで受け取る**。先に入っていた後始末は外す。
 *
 * 外す相手は adapter-node で、SIGTERM を受けた**その場で listen を閉じる**。
 * そのため録画が終わるまで居座っている間、Pod は生きているのに画面が開けなかった
 * (実機で34分。Kubernetes は止まりかけの Pod を Service から外すので、
 * そこへ HTTP も閉じられると、録画中はどこからも見えない)。
 *
 * 落とすのはこちらの `drain` の最後で `process.exit` するときだけにする。
 * 開いている応答は切れるが、これは今までと同じ (以前も待たずに exit していた)。
 *
 * **外れたかどうかは数で分かる。** 0 なら相手がまだ登録していないので、
 * 呼ぶ側があとでもう一度引き取る (`installShutdownHooks`)。
 *
 * **2度目の合図でも落ちないようにする。** `once` にしていた頃は、1度目で
 * 自分の後始末が外れ、2度目は**誰も聞いていない**状態になっていた。そこへ
 * デプロイがもう一度走ると、Node の既定どおりその場で終わる — 録画の途中でも。
 */
export function takeOverSignals(onSignal: (signal: NodeJS.Signals) => void): number {
    let taken = 0;
    let draining = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        taken += process.listenerCount(signal);
        process.removeAllListeners(signal);
        process.on(signal, () => {
            // もう畳んでいる最中。2度目からは受け取るだけで何もしない
            if (draining) return;
            draining = true;
            onSignal(signal);
        });
    }
    return taken;
}

/** 5秒ごとに様子を見る。録画は分単位なので、これ以上細かく見ても意味が無い */
const DRAIN_CHECK = 5000;
/** 待っている間、これだけおきに「まだ待っている」と残す (ms) */
const DRAIN_REPORT = 60_000;

/**
 * 何があっても降りる。**降り損ねを「ぶら下がったまま」にしない。**
 *
 * 実機で、消しはじめられた Pod が **40分たっても降りてこない**ことがあった
 * (録画はとうに終わり、`activeRecordingIds()` も 0、SIGTERM は捕まえている
 * — `/proc/1/status` の `SigCgt` に 15 が立っている — のに生きている)。
 * こうなると `terminationGracePeriodSeconds` (6時間) を使い切るまで
 * **新しい Pod が上がらない**。Recreate なので、その間ずっと古いまま。
 *
 * 待ちの輪を回す前に**先に目覚ましを掛ける**。輪の中で何が起きても、
 * `SHUTDOWN_WAIT` を過ぎたら降りる。原因が分からなくても、
 * 「入れ替えが6時間止まる」だけは起こさない
 */
function forceExitAfter(ms: number, why: string): void {
    const timer = setTimeout(() => {
        console.warn(`[boot] ${why}。これ以上待たずに停止します`);
        try {
            stop();
        } catch (error) {
            console.warn(`[boot] 後始末に失敗しました: ${error}`);
        }
        process.exit(0);
    }, ms);
    // 目覚ましそのものがプロセスを生かし続けないように
    timer.unref?.();
}

async function drain(signal: string): Promise<void> {
    /*
     * **まず残す。** 何をしているかを先に書いておかないと、この先で躓いたときに
     * 「合図を受け取ったのかどうか」すら分からない。実際、降りてこない Pod を
     * 調べたときに、記録から読み取れることが何も無かった
     */
    const recordings = activeRecordingIds().length;
    console.log(`[boot] ${signal} を受けました (録画 ${recordings} 件)`);

    if (config.shutdownWait <= 0 || recordings === 0) {
        stop();
        process.exit(0);
    }

    // 輪を回す前に掛ける。**この先で何が起きても降りる**
    forceExitAfter(config.shutdownWait, '待ち時間を使い切りました');

    beginDraining();
    console.log(`[boot] 録画が終わるまで待ちます (この間も画面は開けます)`);

    const until = Date.now() + config.shutdownWait;
    let reported = Date.now();
    while (activeRecordingIds().length > 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_CHECK));
        // **黙って待たない。** 何を待っているのかが分からないと、外からは固まって見える
        if (Date.now() - reported >= DRAIN_REPORT) {
            reported = Date.now();
            console.log(`[boot] まだ待っています (録画 ${activeRecordingIds().length} 件)`);
        }
    }

    const left = activeRecordingIds().length;
    if (left > 0) {
        console.warn(`[boot] 待ち時間を使い切りました。録画 ${left} 件を残して停止します`);
    } else {
        console.log('[boot] 録画が終わったので停止します');
    }
    stop();
    process.exit(0);
}
