import { mkdirSync } from 'node:fs';
import { listen } from './agent-events';
import { config } from './config';
import { pump, requeueOrphanedJobs } from './encoder';
import { sync, syncServicesOnly } from './epg';
import { collectOnce } from './epg-collect';
import { emit } from './events';
import { pruneHistory, reconcile } from './files';
import { reconcile as logoReconcile, ride, sweep } from './logo';
import { activeRecordingIds, recoverOrphanedRecordings } from './recorder';
import { tick } from './scheduler';
import { beginDraining } from './shutdown';

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
     * **番組表を自分で集める。** mirakc の `epg.update-schedules` に当たるもの。
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
    takeOverSignals((signal) => void drain(signal));
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
 * 読み込み順が変わって**まだ誰も入れていなかった**ときは、外すものが無いだけで
 * 何も壊れない。そのときは今までどおり SIGTERM で listen が閉じる
 * (画面が開けない状態に戻るだけで、録画は守られる)。
 */
export function takeOverSignals(onSignal: (signal: NodeJS.Signals) => void): number {
    let taken = 0;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        taken += process.listenerCount(signal);
        process.removeAllListeners(signal);
        process.once(signal, () => onSignal(signal));
    }
    return taken;
}

/** 5秒ごとに様子を見る。録画は分単位なので、これ以上細かく見ても意味が無い */
const DRAIN_CHECK = 5000;

async function drain(signal: string): Promise<void> {
    const recordings = activeRecordingIds().length;
    if (config.shutdownWait <= 0 || recordings === 0) {
        console.log(`[boot] ${signal} を受けたので停止します`);
        stop();
        process.exit(0);
    }

    beginDraining();
    console.log(
        `[boot] ${signal} を受けましたが、録画 ${recordings} 件が終わるまで待ちます (この間も画面は開けます)`,
    );

    const until = Date.now() + config.shutdownWait;
    while (activeRecordingIds().length > 0 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_CHECK));
    }

    const left = activeRecordingIds().length;
    if (left > 0) {
        console.warn(`[boot] 待ち時間を使い切りました。録画 ${left} 件を残して停止します`);
    }
    stop();
    process.exit(0);
}
