import { mkdirSync } from 'node:fs';
import { config } from './config';
import { pump, requeueOrphanedJobs } from './encoder';
import { sync } from './epg';
import { reconcile } from './files';
import { sweep } from './logo';
import { recoverOrphanedRecordings } from './recorder';
import { tick } from './scheduler';

let started = false;
const timers: ReturnType<typeof setInterval>[] = [];

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

    void guard('epg', sync);
    every(config.epgSyncInterval, 'epg', sync);

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
     * 局ロゴ。mirakc は Mirakurun と違って TS から集めてくれないので、
     * 持っていない局のぶんを少しずつ取りに行く。1回に1局だけ開く
     * (チューナーを塞がないため。録画のついでにも拾っている)
     */
    every(config.logoSweepInterval, 'logo', async () => {
        await sweep();
    });
}

export function stop(): void {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    started = false;
}

/**
 * Pod の入れ替えなどで止められたときの後始末。
 * 録画中のファイルはここでは触らない(書けたところまでは残す)。次の起動で
 * recoverOrphanedRecordings が拾い、まだ放送中なら続きから録り直す。
 */
function installShutdownHooks(): void {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
            console.log(`[boot] ${signal} を受けたので停止します`);
            stop();
            process.exit(0);
        });
    }
}
