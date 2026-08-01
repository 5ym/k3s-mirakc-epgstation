import { mkdirSync } from 'node:fs';
import { config } from './config';
import { now, queryOne } from './db';
import { pump, requeueOrphanedJobs } from './encoder';
import { sync } from './epg';
import * as jellyfin from './jellyfin';
import { reapIdle, stopAll } from './live';
import { failOrphanedRecordings } from './recorder';
import { tick } from './scheduler';

let started = false;
const timers: ReturnType<typeof setInterval>[] = [];

/** 直前に Jellyfin へライブラリ更新を投げた時刻。これ以降に増えたファイルがあれば再度投げる */
let lastLibraryRefresh = 0;

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

/** 新しくライブラリに置かれたファイルがあれば Jellyfin にスキャンさせる */
async function refreshLibraryIfChanged(): Promise<void> {
    const row = queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM recordings
         WHERE library_path IS NOT NULL AND deleted_at IS NULL AND updated_at > ?`,
        lastLibraryRefresh,
    );
    if (row === undefined || row.n === 0) return;
    lastLibraryRefresh = now();
    await jellyfin.refreshLibrary();
}

export function start(): void {
    if (started) return;
    started = true;

    mkdirSync(config.recordedDir, { recursive: true });
    mkdirSync(config.libraryDir, { recursive: true });

    const orphanedRecordings = failOrphanedRecordings();
    const orphanedJobs = requeueOrphanedJobs();
    if (orphanedRecordings > 0 || orphanedJobs > 0) {
        console.log(
            `[boot] 前回の異常終了を回収: 録画 ${orphanedRecordings} 件を失敗扱い / エンコード ${orphanedJobs} 件を再投入`,
        );
    }
    lastLibraryRefresh = now();
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
        await refreshLibraryIfChanged();
    });

    // 誰も読んでいない中継を畳んでチューナーを解放する
    every(config.liveIdleTimeout, 'live', reapIdle);

    // Jellyfin の録画ボタンで作られたタイマーを denpa の予約に変換する
    if (jellyfin.enabled()) {
        every(config.timerImportInterval, 'timers', jellyfin.importTimers);
    }

    // Jellyfin 側で消された録画を一覧から落とす
    void guard('reconcile', jellyfin.reconcile);
    every(config.reconcileInterval, 'reconcile', jellyfin.reconcile);

    if (!jellyfin.enabled()) {
        console.log(
            '[boot] JELLYFIN_URL / JELLYFIN_API_KEY 未設定。新規録画の反映は Jellyfin 側のスキャン任せになります',
        );
    }
}

export function stop(): void {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    // 配信中の ffmpeg を道連れにする。放っておくと孤児プロセスがチューナーを掴み続ける
    stopAll();
    started = false;
}

/**
 * Pod の入れ替えなどで止められたときの後始末。
 * 録画中のファイルはここでは触らない(書けたところまでは残す)。次の起動で
 * failOrphanedRecordings が拾って失敗扱いにする。
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
