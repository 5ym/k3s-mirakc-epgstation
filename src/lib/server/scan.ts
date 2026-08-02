import type { ChannelType } from '../types';
import { config } from './config';
import { sync } from './epg';
import { emit } from './events';

/**
 * チャンネルスキャン。
 *
 * 実際に走らせるのは Mirakurun で、denpa は開始を投げて進み具合を読むだけ。
 * 結果は Mirakurun が自分の `channels.yml` に書き戻す(PVCに置いてある)ので、
 * denpa 側で持つ必要はない。終わったら EPG を取り直して番組表に反映する。
 *
 * 数分かかるうえチューナーを全部使うので、開始だけ受けて裏で進める。
 */

export interface ScanState {
    state: 'idle' | 'running' | 'done' | 'failed';
    type: ChannelType | null;
    /** Mirakurun が返す進捗の行。そのまま画面に出す */
    log: string[];
    /** 見つかったチャンネル数。ログから拾う */
    found: number;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
}

const LOG_LIMIT = 400;

let current: ScanState = {
    state: 'idle',
    type: null,
    log: [],
    found: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
};

let running: AbortController | null = null;

export function status(): ScanState {
    return current;
}

/** ログの行から「見つけた」ものだけ数える。Mirakurun は1件ごとに1行出す */
export function countFound(lines: string[]): number {
    return lines.filter((line) => /channel:.*found|-> found/i.test(line)).length;
}

export interface ScanOptions {
    type: ChannelType;
    min?: number;
    max?: number;
    /** 既にある一覧を更新する形にする。既定はそうする(消してしまわないため) */
    refresh?: boolean;
}

/**
 * Mirakurun のスキャンURL。
 *
 * recisdb はチャンネルの指定形式が Mirakurun の既定と違うので、
 * 名前の形も一緒に渡す(GRなら T13、CSなら CS16。BSは既定のまま)。
 */
export function scanUrl(base: string, options: ScanOptions): string {
    const params = new URLSearchParams({ type: options.type });
    if (options.min !== undefined) params.set('minCh', String(options.min));
    if (options.max !== undefined) params.set('maxCh', String(options.max));
    params.set('refresh', String(options.refresh ?? true));

    const format = { GR: 'T{ch}', CS: 'CS{ch}', BS: '', SKY: '' }[options.type];
    if (format !== '') {
        params.set('useChannelNameFormat', 'true');
        params.set('channelNameFormat', format);
    }
    return `${base}/api/config/channels/scan?${params}`;
}

export function start(options: ScanOptions): { started: boolean; message: string } {
    if (current.state === 'running') return { started: false, message: '既に実行中です' };

    running = new AbortController();
    current = {
        state: 'running',
        type: options.type,
        log: [],
        found: 0,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
    };
    emit('scan');

    void run(options, running.signal);
    return { started: true, message: `${options.type} のスキャンを始めました` };
}

export function cancel(): void {
    running?.abort();
}

function push(line: string): void {
    const trimmed = line.trimEnd();
    if (trimmed === '') return;
    current.log = [...current.log, trimmed].slice(-LOG_LIMIT);
    current.found = countFound(current.log);
}

async function run(options: ScanOptions, signal: AbortSignal): Promise<void> {
    try {
        const res = await fetch(scanUrl(config.mirakurunUrl, options), { method: 'PUT', signal });
        if (!res.ok || res.body === null) {
            throw new Error(`Mirakurun がスキャンを受け付けませんでした (${res.status})`);
        }

        // 進み具合は改行区切りのテキストで流れてくる
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        let lastEmit = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) push(line);

            // 1行ごとに知らせると画面が忙しいので間引く
            const at = Date.now();
            if (at - lastEmit >= 1000) {
                lastEmit = at;
                emit('scan');
            }
        }
        push(buffer);

        current = { ...current, state: 'done', finishedAt: Date.now() };
        emit('scan');

        // 見つけたチャンネルを番組表に出すには取り込みが要る
        await sync();
    } catch (error) {
        const message = signal.aborted ? '中止しました' : String(error);
        current = { ...current, state: 'failed', error: message, finishedAt: Date.now() };
        emit('scan');
    } finally {
        running = null;
    }
}
