import type { CmMode } from '../types';
import { config } from './config';
import { settings } from './settings';
import { lines as readLines, text } from './stream';

/**
 * CM検出。
 *
 * 日本の地上波/BSでは本編とCMの境目・CM同士の境目に必ず無音(数百ms)が入り、
 * CMは15秒の倍数(15/30/60/90...)で構成される。この2つを組み合わせると、
 * ロゴ検出のような重い仕組みを持たなくても実用的な精度でCM区間を出せる。
 *
 * 誤爆したときの被害が大きい(本編が消える)ので、既定は実カットではなく
 * チャプター付与にしてある。cm_cut = 'cut' を明示したものだけ実際に切る。
 */

export interface Range {
    start: number;
    end: number;
}

export interface Silence {
    start: number;
    end: number;
}

export function isCmMode(value: unknown): value is CmMode {
    return value === 'off' || value === 'chapter' || value === 'cut';
}

const SILENCE_START = /silence_start:\s*(-?[\d.]+)/;
const SILENCE_END = /silence_end:\s*(-?[\d.]+)/;
const DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;

export function parseSilences(stderr: string): { silences: Silence[]; duration: number } {
    const silences: Silence[] = [];
    let pending: number | null = null;
    let duration = NaN;

    for (const line of stderr.split('\n')) {
        if (Number.isNaN(duration)) {
            const d = line.match(DURATION);
            if (d !== null) duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
        }
        const start = line.match(SILENCE_START);
        if (start !== null) {
            pending = Math.max(0, Number(start[1]));
            continue;
        }
        const end = line.match(SILENCE_END);
        if (end !== null && pending !== null) {
            silences.push({ start: pending, end: Math.max(pending, Number(end[1])) });
            pending = null;
        }
    }
    return { silences, duration };
}

/**
 * ffmpeg を1パス流して無音位置を取る。映像はデコードしないので実時間の数十分の一で終わる。
 *
 * 長い録画では数分かかるので、進み具合を呼ぶ側へ渡す。「CM検出中」とだけ出して
 * 何分も動かないと、止まっているのか進んでいるのか分からない。
 */
async function detectSilences(
    input: string,
    signal?: AbortSignal,
    onProgress?: (percent: number) => void,
    total = NaN,
): Promise<{ silences: Silence[]; duration: number }> {
    const proc = Bun.spawn(
        [
            config.ffmpeg,
            '-hide_banner',
            '-nostats',
            '-i',
            input,
            // 音声だけ見れば足りる。主音声(0:a:0)のみを対象にする
            '-map',
            '0:a:0',
            '-af',
            `silencedetect=noise=${config.cmSilenceNoise}:d=${config.cmSilenceDuration}`,
            // どこまで読んだかを機械が読める形で出させる
            '-progress',
            'pipe:1',
            '-f',
            'null',
            '-',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
    );

    // 長い録画だと数分かかる。中止を押されたら ffmpeg ごと止める
    const kill = () => proc.kill();
    signal?.addEventListener('abort', kill, { once: true });

    const readProgress = (async () => {
        if (onProgress === undefined || !Number.isFinite(total) || total <= 0) return;
        for await (const line of readLines(proc.stdout as ReadableStream<Uint8Array>)) {
            // 音声だけなので out_time は素直に進む (映像と違って溜め込まない)
            if (!line.startsWith('out_time_us=')) continue;
            const at = Number(line.slice('out_time_us='.length));
            if (Number.isFinite(at)) onProgress(Math.min(1, at / 1e6 / total));
        }
    })();

    try {
        const [stderr] = await Promise.all([text(proc.stderr as ReadableStream<Uint8Array>), readProgress]);
        await proc.exited;
        return parseSilences(stderr);
    } finally {
        signal?.removeEventListener('abort', kill);
    }
}

/** 無音の中央を境界とみなす。無音そのものはCM側にも本編側にも属さないため */
export function boundaries(silences: Silence[], duration: number): number[] {
    const points = silences
        .map((s) => (s.start + s.end) / 2)
        .filter((t) => t > 0 && t < duration)
        .sort((a, b) => a - b);
    return [0, ...points, duration];
}

/** CMの尺は15秒の倍数。許容誤差の中で当てはまるかどうかを見る */
export function isCmLength(seconds: number, tolerance: number): boolean {
    if (seconds < 15 - tolerance || seconds > 180 + tolerance) return false;
    const units = Math.round(seconds / 15);
    return Math.abs(seconds - units * 15) <= tolerance;
}

/**
 * CM区間を求める。
 *
 * 検出結果が明らかにおかしい(番組の半分以上がCM判定)ときは、無音検出が
 * 効いていない/音声が特殊な素材とみなして「CM無し」を返す。本編を削るより
 * CMが残るほうが被害が小さいという判断。
 */
export function detectCmRanges(
    silences: Silence[],
    duration: number,
    options: { tolerance?: number; minBlock?: number; maxRatio?: number } = {},
): Range[] {
    const tolerance = options.tolerance ?? config.cmTolerance;
    const minBlock = options.minBlock ?? config.cmMinBlock;
    const maxRatio = options.maxRatio ?? 0.5;

    if (!Number.isFinite(duration) || duration <= 0) return [];

    const points = boundaries(silences, duration);
    const segments: Range[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        segments.push({ start: points[i], end: points[i + 1] });
    }

    // 連続するCM尺セグメントを1つのCMブロックにまとめる
    const blocks: Range[] = [];
    let current: Range | null = null;
    for (const segment of segments) {
        if (isCmLength(segment.end - segment.start, tolerance)) {
            current = current === null ? { ...segment } : { start: current.start, end: segment.end };
        } else if (current !== null) {
            blocks.push(current);
            current = null;
        }
    }
    if (current !== null) blocks.push(current);

    // 単発の15秒セグメントは本編の短いコーナーと区別が付かないので、一定長以上のブロックだけ採る
    const cm = blocks.filter((b) => b.end - b.start >= minBlock);

    const total = cm.reduce((sum, b) => sum + (b.end - b.start), 0);
    if (total > duration * maxRatio) return [];

    return cm;
}

/** CM区間の裏返し。エンコード時に残す区間 */
export function keepRanges(cm: Range[], duration: number): Range[] {
    const keep: Range[] = [];
    let cursor = 0;
    for (const block of cm) {
        if (block.start - cursor > 0.5) keep.push({ start: cursor, end: block.start });
        cursor = Math.max(cursor, block.end);
    }
    if (duration - cursor > 0.5) keep.push({ start: cursor, end: duration });
    return keep;
}

/**
 * ffmetadata 形式のチャプター定義。本編とCMを交互のチャプターにして、
 * プレイヤーのチャプター送りでCMを飛ばせるようにする(ファイルは切らない)。
 */
export function chapterMetadata(cm: Range[], duration: number): string {
    const keep = keepRanges(cm, duration);
    const chapters = [
        ...keep.map((r) => ({ ...r, title: '本編' })),
        ...cm.map((r) => ({ ...r, title: 'CM' })),
    ].sort((a, b) => a.start - b.start);

    const lines = [';FFMETADATA1'];
    for (const chapter of chapters) {
        lines.push(
            '[CHAPTER]',
            'TIMEBASE=1/1000',
            `START=${Math.round(chapter.start * 1000)}`,
            `END=${Math.round(chapter.end * 1000)}`,
            `title=${chapter.title}`,
        );
    }
    return `${lines.join('\n')}\n`;
}

/**
 * 尺とフレームレートを先に取る。
 *
 * ffmpeg の stderr に出る `Duration:` を当てにしていた頃は、TS によっては
 * 拾えず、進み具合が最後まで 0% のままになっていた。先に ffprobe で押さえる。
 */
export async function probeVideo(
    input: string,
): Promise<{ duration: number; fps: number; width: number; height: number }> {
    const read = async (args: string[]): Promise<string> => {
        const proc = Bun.spawn([config.ffprobe, '-v', 'error', ...args, input], {
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const out = (await text(proc.stdout as ReadableStream<Uint8Array>)).trim();
        await proc.exited;
        return out;
    };

    let duration = NaN;
    let fps = NaN;
    let width = NaN;
    let height = NaN;
    try {
        duration = Number(await read(['-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1']));
        // "30000/1001,1440,1080" の形で返る
        const [rate, w, h] = (
            await read([
                '-select_streams',
                'v:0',
                '-show_entries',
                'stream=avg_frame_rate,width,height',
                '-of',
                'csv=p=0',
            ])
        ).split(',');
        const [num, den] = (rate ?? '').split('/').map(Number);
        fps = den ? num / den : num;
        width = Number(w);
        height = Number(h);
    } catch {
        // ffprobe が使えない環境。呼ぶ側が NaN を見て諦める
    }
    const positive = (value: number) => (Number.isFinite(value) && value > 0 ? value : NaN);
    return {
        duration: positive(duration),
        fps: positive(fps),
        // 字幕を絵で焼くときの画面の大きさ。libaribcaption は既定で 1440x1080 と
        // みなすので、渡さないと 1920x1080 の録画で字幕だけ横に伸びる
        width: positive(width),
        height: positive(height),
    };
}

/** 尺だけを軽く取る。CM区間を秒で扱うために必要 */
async function probeDuration(input: string): Promise<number> {
    return (await probeVideo(input)).duration;
}

export interface CmDetection {
    cm: Range[];
    duration: number;
    note: string;
    /** ロゴを当てられなかった。位置を教えてもらえば次から効く (jls のときだけ) */
    logoMissing: boolean;
}

export interface CmOptions {
    signal?: AbortSignal;
    /** 局名。logoframe に渡すとこの名前でロゴを覚える */
    channel?: string;
    /** 局のID。覚えたロゴの置き場を局ごとに分けるのに使う */
    serviceId?: number;
    /** 手で教えてもらったロゴの位置 ("x,y,w,h") */
    area?: string;
    /** 無音検出の進み具合 */
    onProgress?: (percent: number) => void;
    /** jls の中でいま何をしているか。段階の名前だけでは進み具合が分からない */
    onStep?: (label: string) => void;
}

/**
 * 設定された検出器でCM区間を求める。
 * jls を選んでいても、ロゴデータ未整備などで結果が空なら無音ベースに落とす
 * (何も検出できないよりは、チャプターだけでも付いたほうが使えるため)。
 */
export async function detectCm(input: string, options: CmOptions = {}): Promise<CmDetection> {
    const { signal, onProgress } = options;
    /** ロゴを当てられなかったことは、無音検出に落ちたあとも伝える */
    let logoMissing = false;
    /** jls が使えなかった理由。落ちた先の説明に足す */
    let fallback = '';
    // 検出のしかたは設定画面で決める (jls は確かだが録画1本あたり数分かかる)
    if (settings().cmDetector === 'jls') {
        const duration = await probeDuration(input);
        if (Number.isFinite(duration)) {
            const { detectWithJls } = await import('./cm-jls');
            const result = await detectWithJls(input, duration, options);
            logoMissing = result.logoMissing;
            if (result.cm.length > 0) {
                return { cm: result.cm, duration, note: result.note, logoMissing };
            }
            fallback = result.note;
            console.warn(`[cm] jls で検出できなかったため無音検出に切り替えます: ${result.note}`);
        }
    }

    /*
     * 尺は先に測る。silencedetect の出力からも拾えるが、それだと終わるまで
     * 分母が分からず、進み具合を出せない
     */
    const measured = await probeDuration(input);
    const { silences, duration } = await detectSilences(input, signal, onProgress, measured);
    /*
     * 落ちた理由まで書く。「無音 8 箇所」とだけ出していた頃は、jls を選んで
     * いるのになぜ無音検出になったのかが画面から分からなかった
     */
    const note = `無音 ${silences.length} 箇所`;
    return {
        cm: detectCmRanges(silences, duration),
        duration,
        note: fallback === '' ? note : `${note} — ロゴでの検出をやめて無音だけで判定しました (${fallback})`,
        logoMissing,
    };
}
