const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

export function time(ms: number): string {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(ms: number): string {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function duration(startAt: number, endAt: number): string {
    const min = Math.round((endAt - startAt) / 60000);
    if (min < 60) return `${min}分`;
    const rest = min % 60;
    // 「24時間0分」のような書き方は読みにくいので、端数が無いときは時間だけ出す
    return rest === 0 ? `${Math.floor(min / 60)}時間` : `${Math.floor(min / 60)}時間${rest}分`;
}

export function size(bytes: number): string {
    if (bytes <= 0) return '-';
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
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
