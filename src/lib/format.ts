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

/**
 * 進み具合。**小数第1位まで出す。**
 *
 * 整数だけだと、1時間かかるエンコードでは同じ数字が30秒以上動かない。
 * 動いていないのか止まったのか画面から判らなかったので、1桁足してある
 */
export function percent(value: number): string {
    const clamped = Math.min(Math.max(value, 0), 1);
    return `${(clamped * 100).toFixed(1)}%`;
}

/**
 * 残り時間の見込み。**秒まで出す。**
 *
 * 分どまりだと終わりぎわの数分が「あと1分」で固まってしまい、
 * 見終わるまで待てばいいのか席を立っていいのか判らなかった。
 * 秒の桁は多少ふらつくが、動いていることそのものが情報になる
 */
export function eta(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms) || ms <= 0) return '';
    const total = Math.round(ms / 1000);
    const sec = total % 60;
    const min = Math.floor(total / 60) % 60;
    const hour = Math.floor(total / 3600);
    if (hour > 0) return `あと${hour}時間${pad(min)}分${pad(sec)}秒`;
    if (min > 0) return `あと${min}分${pad(sec)}秒`;
    return `あと${sec}秒`;
}

/**
 * エンコードの段階。ffmpeg が回る前の下ごしらえは進み具合を出せないので、
 * 何をしているところなのかを状態として出す。
 */
const PHASE_LABEL: Record<string, string> = {
    descramble: 'スクランブル解除中',
    cm: 'CM検出中',
    cut: 'CMカット中',
    encode: 'エンコード中',
};

/** 行の状態。エンコードが動いていればその段階、そうでなければ録画の状態 */
function encodeLabel(job: { state: string; phase: string | null } | null): string | null {
    if (job === null) return null;
    if (job.state === 'queued') return 'エンコード待ち';
    if (job.state !== 'running') return null;
    return PHASE_LABEL[job.phase ?? 'encode'] ?? 'エンコード中';
}

/**
 * 一覧の行に出す状態。
 *
 * 録画の状態 (`state`) は録画そのものの話しかしない。エンコードは別の仕事なので、
 * 動いていればその段階を、落ちていれば落ちたことを、こちらで足す。
 * エンコードの失敗を録画の状態に書き込んでいた頃は、生TSが無事なのに
 * 「失敗」と出て再生もダウンロードもできなくなっていた
 */
export function rowState(rec: {
    state: string;
    job_state: string | null;
    job_phase: string | null;
    encode_error: string | null;
}): { label: string; badge: string } {
    const running = encodeLabel(
        rec.job_state === null ? null : { state: rec.job_state, phase: rec.job_phase },
    );
    if (running !== null) return { label: running, badge: badgeClass(rec.job_state ?? '') };
    // 動いているものが無く、いちばん新しいエンコードが失敗している
    if (rec.encode_error !== null && rec.encode_error !== '') {
        return { label: 'エンコード失敗', badge: badgeClass('failed') };
    }
    return { label: stateLabel(rec.state), badge: badgeClass(rec.state) };
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
        case 'deleted':
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
    // 消したあとも行は履歴として残る。「視聴可能」のままだと嘘になる
    deleted: '削除済み',
    queued: '待機中',
    running: '実行中',
};

export function stateLabel(state: string): string {
    return STATE_LABEL[state] ?? state;
}

/**
 * 番組表のマスの色。ジャンル(大分類)ごとに変える。
 *
 * 白黒のマスが敷き詰まっていると、どこに何があるのか目で追えない。
 * 「この帯は全部ドラマ」「ここから映画」が色で分かるようにする。
 *
 * Tailwind はソースに書かれた文字列しか拾わないので、組み立てずに丸ごと書く。
 * 下地は薄く敷いて左に濃い線を引く。濃く塗ると文字が読めなくなる
 */
const GENRE_TINT: Record<number, string> = {
    0: 'bg-sky-500/15 hover:bg-sky-500/25 border-sky-500',
    1: 'bg-green-500/15 hover:bg-green-500/25 border-green-500',
    2: 'bg-teal-500/15 hover:bg-teal-500/25 border-teal-500',
    3: 'bg-rose-500/15 hover:bg-rose-500/25 border-rose-500',
    4: 'bg-fuchsia-500/15 hover:bg-fuchsia-500/25 border-fuchsia-500',
    5: 'bg-orange-500/15 hover:bg-orange-500/25 border-orange-500',
    6: 'bg-indigo-500/15 hover:bg-indigo-500/25 border-indigo-500',
    7: 'bg-violet-500/15 hover:bg-violet-500/25 border-violet-500',
    8: 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500',
    9: 'bg-pink-500/15 hover:bg-pink-500/25 border-pink-500',
    10: 'bg-lime-500/15 hover:bg-lime-500/25 border-lime-500',
    11: 'bg-cyan-500/15 hover:bg-cyan-500/25 border-cyan-500',
};

/** ジャンルの付いていない番組。色を持たせず、これまでどおりの地の色にする */
const NO_GENRE = 'bg-base-200 hover:bg-base-300 border-base-300';

/** `programs.genres` (大分類の番号を並べた JSON) から色を決める。先頭を代表とする */
export function genreTint(genres: string | null): string {
    if (genres === null || genres === '') return NO_GENRE;
    try {
        const list = JSON.parse(genres) as number[];
        return GENRE_TINT[list[0]] ?? NO_GENRE;
    } catch {
        return NO_GENRE;
    }
}

export const CM_LABEL: Record<string, string> = {
    off: 'そのまま',
    chapter: 'チャプター',
    cut: 'カット',
};

/**
 * ロゴでの判定が使えなかったときに、CM検出の覚え書き (`recordings.cm_note`) へ
 * 入れる目印。無音検出に落ちた理由はこの後ろに続く。
 */
export const JLS_UNUSABLE = 'jls は使えず';

/**
 * その録画に「ロゴの位置を教える」口を出すか。
 *
 * **覚え書きから読む。別の列では持たない。** 印を立てていた頃は、後から条件を
 * 広げても既に録ってある分には効かなかった (「結果の100%がCM判定だったので捨てた」
 * ときも教えられるようにしたのに、実機の2本は印が 0 のままで画面に出なかった)。
 *
 * 落ちた理由がロゴとは限らない (無音側の道具が落ちることもある) が、そのときも
 * 出しておく。理由は覚え書きに書いてあるし、位置を教えて損になることはない。
 */
export function logoUnusable(cmNote: string | null): boolean {
    return cmNote?.includes(JLS_UNUSABLE) === true;
}

/** ロゴまで見て判定できたときの覚え書き (`cm-jls.detectWithJls`) */
const JLS_OK = 'join_logo_scp';

/**
 * その覚え書きを画面に出すか。
 *
 * **うまくいったときは何も出しません。** `join_logo_scp` とだけ書いてあっても
 * 読む人には何の情報にもならず、チャプターを見れば結果は分かります。ここに
 * 何か書いてあること自体が「いつもの精度は出ていない」の合図になります。
 */
export function cmNoteWorthShowing(cmNote: string | null): boolean {
    return cmNote !== null && cmNote !== '' && cmNote !== JLS_OK;
}

/*
 * 番組の説明に入っているURLを拾う。
 *
 * 番組表の説明欄には公式サイトや配信の告知が素のまま書いてある。読めるだけで
 * 押せないと、結局手で選んで貼り直すことになる。
 *
 * 閉じ括弧や句点はURLの一部にしない。「…example.com/)」のような書き方が多く、
 * そのまま含めると開けないリンクになる。日本語の記号は URL に現れないので切る
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>）」』】〉、。，]+/g;
const TRAILING = /[.,!?:;)\]}]+$/;

export interface TextPart {
    text: string;
    /** リンクなら宛先。素の文字なら undefined */
    href?: string;
}

/** 説明文を「素の文字」と「リンク」に切り分ける。`{@html}` を使わずに済ませるため */
export function linkify(text: string): TextPart[] {
    const parts: TextPart[] = [];
    let cursor = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        const at = match.index;
        const url = match[0].replace(TRAILING, '');
        if (url === '') continue;
        if (at > cursor) parts.push({ text: text.slice(cursor, at) });
        parts.push({ text: url, href: url });
        cursor = at + url.length;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor) });
    return parts;
}
