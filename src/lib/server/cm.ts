import type { CmMode } from '../types';
import { config } from './config';
import { text } from './stream';

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

/** ffmpeg を1パス流して無音位置を取る。映像はデコードしないので実時間の数十分の一で終わる */
export async function detectSilences(input: string): Promise<{ silences: Silence[]; duration: number }> {
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
            '-f',
            'null',
            '-',
        ],
        { stdout: 'ignore', stderr: 'pipe' },
    );

    const stderr = await text(proc.stderr as ReadableStream<Uint8Array>);
    await proc.exited;
    return parseSilences(stderr);
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

/** select/aselect に渡す区間式。`between(t,a,b)+between(t,c,d)` の形 */
export function selectExpression(keep: Range[]): string {
    return keep.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join('+');
}

/** 尺だけを軽く取る。CM区間を秒で扱うために必要 */
export async function probeDuration(input: string): Promise<number> {
    try {
        const proc = Bun.spawn(
            [
                config.ffprobe,
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=nw=1:nk=1',
                input,
            ],
            { stdout: 'pipe', stderr: 'ignore' },
        );
        const out = (await text(proc.stdout as ReadableStream<Uint8Array>)).trim();
        await proc.exited;
        const seconds = Number(out);
        if (Number.isFinite(seconds) && seconds > 0) return seconds;
    } catch {
        // ffprobe が使えない環境では silencedetect のログから取る
    }
    return NaN;
}

export interface CmDetection {
    cm: Range[];
    duration: number;
    note: string;
}

/**
 * 設定された検出器でCM区間を求める。
 * jls を選んでいても、ロゴデータ未整備などで結果が空なら無音ベースに落とす
 * (何も検出できないよりは、チャプターだけでも付いたほうが使えるため)。
 */
export async function detectCm(input: string): Promise<CmDetection> {
    if (config.cmDetector === 'jls') {
        const duration = await probeDuration(input);
        if (Number.isFinite(duration)) {
            const { detectWithJls } = await import('./cm-jls');
            const result = await detectWithJls(input, duration);
            if (result.cm.length > 0) return { cm: result.cm, duration, note: result.note };
            console.warn(`[cm] jls で検出できなかったため無音検出に切り替えます: ${result.note}`);
        }
    }

    const { silences, duration } = await detectSilences(input);
    return {
        cm: detectCmRanges(silences, duration),
        duration,
        note: `silencedetect: 無音 ${silences.length} 箇所`,
    };
}
