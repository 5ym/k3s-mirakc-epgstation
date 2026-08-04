import { JLS_UNUSABLE } from '../format';
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

/**
 * これ以上がCM判定になったら、その結果は信じない。
 *
 * **無音検出と join_logo_scp で同じ値を使う。** どちらも「検出が効いていない」
 * 兆候は同じ (番組が丸ごとCMになる) で、本編を削るよりCMが残るほうが被害が小さい、
 * という判断も同じ。数字を別々に持って「そろえてある」と書いていた頃は、
 * 片方だけ動かせる状態のまま「そろえてある」と書いてあるだけでした。
 */
export const MAX_CM_RATIO = 0.5;

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
    const maxRatio = options.maxRatio ?? MAX_CM_RATIO;

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

/**
 * 区間の裏返し。**CM ↔ 本編のどちらの向きにも同じものを使う。**
 *
 * 「CMを渡して残す区間をもらう」(チャプター・実カット) と
 * 「join_logo_scp の残す区間を渡してCMをもらう」(cm-jls) は同じ計算なので、
 * 1つにしてある。同じものを2箇所に置いていた頃は、片方だけが渡された区間を
 * 並べ替えていて、**同じ入力から違う答えが出る**状態になっていた。
 *
 * 0.5秒より短い隙間は作らない (切っても意味が無く、チャプターだけが増える)。
 */
export function invertRanges(ranges: Range[], duration: number): Range[] {
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const out: Range[] = [];
    let cursor = 0;
    for (const block of sorted) {
        if (block.start - cursor > 0.5) out.push({ start: cursor, end: block.start });
        cursor = Math.max(cursor, block.end);
    }
    if (duration - cursor > 0.5) out.push({ start: cursor, end: duration });
    return out;
}

/**
 * 残す区間の**頭を少し前へ戻す**。
 *
 * 切り出しは `-ss` で頭出ししてから `-c copy` するので、**キーフレーム単位**に
 * なる。ffmpeg は指定した時刻の次のキーフレームから書き出すため、本編の頭が
 * 1 GOP ぶん (地上波の MPEG-2 で 0.5 秒ほど) 削れることがある。実機でも
 * 「本編の頭が一瞬欠ける」形で出ていた。
 *
 * 戻したぶんだけ CM の尻が残るが、**本編を削るよりそちらのほうが被害が小さい**
 * (この判断は `tooMuchCm` と同じ)。
 *
 * 戻した結果 前の区間とくっついたら1つにまとめる (切り出しが1回減る)。
 */
export function widenKeep(keep: Range[], margin: number): Range[] {
    const out: Range[] = [];
    for (const range of [...keep].sort((a, b) => a.start - b.start)) {
        const previous = out.at(-1);
        const start = Math.max(0, range.start - margin, previous?.end ?? 0);
        if (previous !== undefined && start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
            continue;
        }
        out.push({ start, end: range.end });
    }
    return out;
}

/**
 * ffmetadata 形式のチャプター定義。本編とCMを交互のチャプターにして、
 * プレイヤーのチャプター送りでCMを飛ばせるようにする(ファイルは切らない)。
 */
export function chapterMetadata(cm: Range[], duration: number): string {
    const keep = invertRanges(cm, duration);
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
 * ffprobe の `key=value` 出力を読む。**位置では読まない。**
 *
 * ここは実機で2回踏んでいる。どちらも「1本のTSに局が何本も乗っている」ことが効く
 * (TOKYO MX は MX1 と MX2 が同じTSにいる):
 *
 * 1. **同じ行が番組の数だけ並ぶ。** `-select_streams v:0` を付けても、ffprobe は
 *    番組ごとに v:0 を1つずつ出す。`avg_frame_rate` だけを取って丸ごと
 *    `split('/')` していた頃は、分母が `1001\n30000` になって NaN に落ち、
 *    分子の **30000** をフレームレートとして採っていた。
 * 2. **`-show_entries` に書いた順では返らない。** `avg_frame_rate,width,height`
 *    と頼んでも `1440,1080,30000/1001` (幅,高さ,fps) の順で来る。位置で受けていた
 *    頃は **1440** をフレームレートとして採り、ついでに高さが `30000/1001` に
 *    なっていた (字幕を焼くときの画面の大きさが壊れる)。
 *
 * どちらも join_logo_scp の `Trim` をコマから秒に直すところに効いて、
 * 30分アニメの本編4万2千コマが 1.4秒 / 29秒 に潰れ、「番組の 100% / 98% がCM」で
 * 毎回捨てられていた。ロゴは合致率79%で正しく当たっていたので、
 * 画面からはロゴが悪いようにしか見えなかった (実機の録画34・35・38)。
 *
 * 鍵で引き、**同じ鍵は最初のものを採る**。
 */
export function fields(out: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of out.split('\n')) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        if (!map.has(key)) map.set(key, line.slice(eq + 1).trim());
    }
    return map;
}

/** `30000/1001` の形のフレームレートを数に直す。読めなければ NaN */
export function parseFrameRate(value: string | undefined): number {
    const [num, den] = (value ?? '').trim().split('/').map(Number);
    const fps = den ? num / den : num;
    return Number.isFinite(fps) && fps > 0 ? fps : NaN;
}

/**
 * 尺とフレームレートを先に取る。
 *
 * ffmpeg の stderr に出る `Duration:` を当てにしていた頃は、TS によっては
 * 拾えず、進み具合が最後まで 0% のままになっていた。先に ffprobe で押さえる。
 */
export async function probeVideo(input: string): Promise<{
    duration: number;
    fps: number;
    width: number;
    height: number;
    videoStart: number;
    formatStart: number;
    sar: number;
}> {
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
    let videoStart = 0;
    let formatStart = NaN;
    let sar = 1;
    try {
        // `nk=1` (鍵を出さない) にはしない。鍵で引くために必ず `key=value` で受ける
        const format = fields(
            await read(['-show_entries', 'format=duration,start_time', '-of', 'default=nw=1']),
        );
        duration = Number(format.get('duration'));
        formatStart = Number(format.get('start_time'));

        const stream = fields(
            await read([
                '-select_streams',
                'v:0',
                '-show_entries',
                'stream=avg_frame_rate,width,height,start_time,sample_aspect_ratio',
                '-of',
                'default=nw=1',
            ]),
        );
        fps = parseFrameRate(stream.get('avg_frame_rate'));
        width = Number(stream.get('width'));
        height = Number(stream.get('height'));
        sar = parseRatio(stream.get('sample_aspect_ratio'));

        /*
         * **頭出しは「実際に復号できた1コマ目」で測る。** stream の start_time は
         * 最初の**パケット**の時刻で、そこから何コマかは参照先が録れておらず
         * 捨てられる。実機ではその差が 0.567 秒 (17コマ = 半GOP) あった。
         *
         *     start_time 6115.872 / 実際に出た1コマ目 6116.439 (I)
         *
         * 上限 (MAX_LEAD_IN) より先まで読んでも使わないので、そのぶんだけ見る
         */
        const first = firstFrameTime(
            await read([
                '-select_streams',
                'v:0',
                '-show_frames',
                '-read_intervals',
                `%+${MAX_LEAD_IN + 1}`,
                '-show_entries',
                'frame=best_effort_timestamp_time',
                '-of',
                'default=nw=1',
            ]),
        );
        // 復号できるコマが見つからなければパケットの時刻で代用する
        const start = Number.isFinite(first) ? first : Number(stream.get('start_time'));
        videoStart = leadIn(start, formatStart);
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
        /**
         * **映像が始まるまでの間。入れ物の始まりから、実際に映る1コマ目まで。**
         *
         * TS は音声のほうが先に始まっているのがふつうで、実機では 0.930 秒あった。
         * そのまま焼くと出来上がりも音声だけの区間から始まり、**1コマ目を 0 秒
         * として数えるプレイヤー**ではそのぶん字幕が早く出る。
         *
         * **ここを捨てる** (encoder.buildArgs の `-ss`)。ずらす (`-output_ts_offset`)
         * のでは直らなかった — Matroska は負の時刻を持てないので、下がった音声を
         * muxer が押し戻し、全トラックまとめて元の位置に戻る。実測でも 0.363 秒
         * 渡して動いたのは 0.022 秒だけだった
         */
        videoStart,
        /**
         * **入れ物そのものの始まり (PTS)。** 頭からの秒数ではなく放送の時刻で、
         * この録画では 6115.51 だった。
         *
         * ffmpeg は入力の時刻からこれを引いて 0 から数え直す。**同じ TS を
         * 別々に ffmpeg へ通すときは、双方が同じものを引いていないと噛み合わない** —
         * 字幕を絵にするとき (`subtitle.ts`) がまさにそれで、あちらは
         * 字幕1枚目を 0 とみなしていたため、出来上がりで字幕だけ 10 秒早く出ていた。
         * 引く数をこちらから渡して揃える
         */
        formatStart: Number.isFinite(formatStart) ? formatStart : NaN,
        /**
         * 画素の横長さ。1440x1080 の地上波HDは 4:3 で、これを掛けると 1920 になる。
         * 読めなければ 1 (正方形) とみなす
         */
        sar,
    };
}

/**
 * 映像が始まるまでの間。**入れ物の始まりから数える。**
 *
 * TS の `start_time` は**放送の時刻そのもの** (PTS) で、頭からの秒数ではない。
 * 引き算をせずに使っていたときは `-output_ts_offset -62170` (−17時間) を
 * 渡してしまい、エンコードの進み具合が動かなくなった (実機)。
 *
 * ずれが数秒を超えたら 0 にする。読み違えているほうが疑わしく、
 * 大きくずらすと壊れ方が派手になる
 */
const MAX_LEAD_IN = 5;

/**
 * `ffprobe -show_frames` の吐き出しから、**最初に復号できたコマの時刻**を読む。
 *
 * 頭のほうは参照先が録れていないコマが混ざるので、ffprobe も ffmpeg も
 * 最初の I フレームまで捨てる。ここで返るのは捨て終わったあとの1コマ目。
 * 1件も無ければ NaN (呼ぶ側がパケットの時刻で代用する)
 */
export function firstFrameTime(output: string): number {
    for (const line of output.split('\n')) {
        const match = /^best_effort_timestamp_time=(-?[\d.]+)/.exec(line.trim());
        if (match !== null) {
            const at = Number(match[1]);
            if (Number.isFinite(at)) return at;
        }
    }
    return NaN;
}

export function leadIn(streamStart: number, formatStart: number): number {
    if (!Number.isFinite(streamStart)) return 0;
    const from = Number.isFinite(formatStart) ? formatStart : 0;
    const lead = streamStart - from;
    return lead > 0 && lead <= MAX_LEAD_IN ? lead : 0;
}

/** `4:3` のような比を数にする。読めなければ 1 */
export function parseRatio(value: string | undefined): number {
    const match = /^(\d+)[:/](\d+)$/.exec((value ?? '').trim());
    if (match === null) return 1;
    const [, a, b] = match;
    const ratio = Number(a) / Number(b);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** 尺だけを軽く取る。CM区間を秒で扱うために必要 */
async function probeDuration(input: string): Promise<number> {
    return (await probeVideo(input)).duration;
}

export interface CmDetection {
    cm: Range[];
    duration: number;
    note: string;
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
    /** jls が使えなかった理由。落ちた先の説明に足す */
    let fallback = '';
    // 検出のしかたは設定画面で決める (jls は確かだが録画1本あたり数分かかる)
    if (settings().cmDetector === 'jls') {
        // 尺とフレームレートは1回で取る。join_logo_scp の Trim をコマから秒に直すのに要る
        const { duration, fps } = await probeVideo(input);
        if (Number.isFinite(duration)) {
            const { detectWithJls } = await import('./cm-jls');
            const result = await detectWithJls(input, duration, { ...options, fps });
            if (result.cm.length > 0) {
                return { cm: result.cm, duration, note: result.note };
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
     * いるのになぜ無音検出になったのかが画面から分からなかった。
     *
     * **この文言から「ロゴの位置を教える口を出すか」を決める** (format.logoUnusable)。
     * 別の列で持っていた頃は、後から条件を広げても既に録ってある分に効かなかった
     */
    const note = `無音 ${silences.length} 箇所`;
    return {
        cm: detectCmRanges(silences, duration),
        duration,
        note: fallback === '' ? note : `${note} (${JLS_UNUSABLE}: ${fallback})`,
    };
}
