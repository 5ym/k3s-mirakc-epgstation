const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

export function time(ms: number): string {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 日付だけ。時刻と2行に分けて出すとき用 */
export function date(ms: number): string {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

export function dateTime(ms: number): string {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function durationMs(ms: number): string {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min}分`;
    const rest = min % 60;
    // 「24時間0分」のような書き方は読みにくいので、端数が無いときは時間だけ出す
    return rest === 0 ? `${Math.floor(min / 60)}時間` : `${Math.floor(min / 60)}時間${rest}分`;
}

export function duration(startAt: number, endAt: number): string {
    return durationMs(endAt - startAt);
}

/**
 * 録画の長さ。実際に録れた長さがあればそちらを出す。
 *
 * 番組表の尺 (end_at - start_at) は予定でしかなく、途中で止めたときや
 * CMを切ったときは出来上がりと合わない。取れていない古い行は予定で代用する。
 */
export function recordedDuration(recording: {
    duration_ms: number | null;
    start_at: number;
    end_at: number;
}): string {
    return recording.duration_ms != null && recording.duration_ms > 0
        ? durationMs(recording.duration_ms)
        : duration(recording.start_at, recording.end_at);
}

export function size(bytes: number): string {
    if (bytes <= 0) return '-';
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

/**
 * 残り時間の見込み。分より細かくは出さない。
 * 秒まで出すと数字が落ち着かず、かえって読みにくい。
 */
export function eta(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms) || ms <= 0) return '';
    const min = Math.round(ms / 60000);
    if (min < 1) return 'あと1分未満';
    return `あと${durationMs(min * 60000)}`;
}

/**
 * エンコードの段階。ffmpeg が回る前の下ごしらえは進み具合を出せないので、
 * 何をしているところなのかを状態として出す。
 */
export const PHASE_LABEL: Record<string, string> = {
    descramble: 'スクランブル解除中',
    cm: 'CM検出中',
    cut: 'CMカット中',
    encode: 'エンコード中',
};

/** 行の状態。エンコードが動いていればその段階、そうでなければ録画の状態 */
export function encodeLabel(job: { state: string; phase: string | null } | null): string | null {
    if (job === null) return null;
    if (job.state === 'queued') return 'エンコード待ち';
    if (job.state !== 'running') return null;
    return PHASE_LABEL[job.phase ?? 'encode'] ?? 'エンコード中';
}

/** daisyUI の badge 色。状態が一目で分かるようにする */
export function badgeClass(state: string): string {
    switch (state) {
        case 'recording':
        case 'running':
            return 'badge-error';
        case 'encoding':
        case 'queued':
            return 'badge-warning';
        case 'available':
        case 'done':
            return 'badge-success';
        case 'conflict':
        case 'failed':
            return 'badge-error badge-outline';
        case 'canceled':
            return 'badge-ghost';
        default:
            return 'badge-info';
    }
}

export const STATE_LABEL: Record<string, string> = {
    scheduled: '予約済み',
    conflict: '競合',
    recording: '録画中',
    done: '完了',
    failed: '失敗',
    canceled: 'キャンセル',
    missed: '録り逃し',
    recorded: '録画済み',
    encoding: 'エンコード中',
    available: '視聴可能',
    queued: '待機中',
    running: '実行中',
};

export function stateLabel(state: string): string {
    return STATE_LABEL[state] ?? state;
}

export const CM_LABEL: Record<string, string> = {
    off: 'そのまま',
    chapter: 'チャプター',
    cut: 'カット',
};

/** 検出したCM区間 (JSON) を「12:30-14:30」のような一覧にする */
export function cmRanges(json: string | null): string {
    if (json === null || json === '') return '';
    try {
        const ranges: { start: number; end: number }[] = JSON.parse(json);
        if (ranges.length === 0) return '検出なし';
        const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        return ranges.map((r) => `${clock(r.start)}-${clock(r.end)}`).join(', ');
    } catch {
        return '';
    }
}
