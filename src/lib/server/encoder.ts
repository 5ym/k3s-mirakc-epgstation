import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EncodeJob, Recording, VideoCodec } from '../types';
import { type CmDetection, chapterMetadata, detectCm, keepRanges, type Range } from './cm';
import { config } from './config';
import { database, now, queryOne } from './db';
import { emit } from './events';
import { removeIfExists } from './fsx';
import { libraryPath } from './library';
import { writeNfo, writeThumbnail } from './metadata';
import { descramble, isScrambled } from './scramble';
import { chunks } from './stream';
import { notify } from './webhook';

export function isVideoCodec(value: unknown): value is VideoCodec {
    return value === 'av1' || value === 'h264';
}

/**
 * 映像コーデックごとの設定。
 * AV1 は同じ画質でファイルが小さいがエンコードが遅い。非力なマシンでは h264 を選ぶ。
 * H.264 は 8bit にしておく(10bit を再生できないクライアントが残っているため)。
 */
function videoArgs(codec: VideoCodec): { filter: string; encoder: string[] } {
    if (codec === 'h264') {
        return {
            filter: 'bwdif,format=yuv420p',
            encoder: ['libx264', '-preset', config.encodeH264Preset, '-crf', String(config.encodeH264Crf)],
        };
    }
    return { filter: 'bwdif,format=yuv420p10le', encoder: ['libsvtav1'] };
}

const DUAL_MONO = 2;
/** 進捗をDBに書き戻す間隔。1フレームごとに書くとWAL肥大とUIのちらつきの原因になる */
const PROGRESS_INTERVAL = 2000;

/** 同時実行数を数えるための実行中ジョブID。ffmpeg の起動前から入る */
const runningJobs = new Set<number>();
/** kill 用。ffmpeg が起動している間だけ入る */
const procs = new Map<number, Bun.Subprocess>();
/** ユーザーが止めたジョブ。失敗と区別して再試行しないため */
const canceled = new Set<number>();

export interface EncodeOptions {
    /** CM実カット時に残す区間。null なら全部残す */
    keep?: Range[] | null;
    /** チャプター(CM位置)を書き込む ffmetadata ファイル */
    chaptersFile?: string | null;
}

/**
 * ffmpeg の引数。EPGStation 時代の enc.js をそのまま移植したもので、
 * 各フラグの理由はコメントに残してある(ARIB字幕の焼き込み、インタレ解除、デュアルモノ分離)。
 *
 * CM実カット時だけは filter_complex で select を掛けるため、フィルタの組み方が変わる。
 */
export function buildArgs(
    input: string,
    output: string,
    audioType: number | null,
    seek: number | null,
    codec: VideoCodec = 'av1',
    options: EncodeOptions = {},
): string[] {
    const video = videoArgs(codec);

    const args = ['-y'];

    // 字幕用
    args.push('-fix_sub_duration');
    // ARIB字幕をビットマップとして焼き込む(再生側フォントに依存させない)。Rounded M+ 1m for ARIB は
    // libaribcaption 公式推奨フォントで、丸ゴシック+JIS第三水準漢字+ARIB外字を1本でカバーする
    args.push('-sub_type', 'bitmap', '-font', 'Rounded M+ 1m for ARIB');
    if (seek !== null) {
        // 録画開始直後の1秒未満だけ、多重化されたもう一方の映像ストリームのPAT/PMTが確定しておらず
        // エンコーダの初期化(fps/解像度確定)自体が失敗することがある。
        // 最初の失敗を検知した後だけ頭を少し捨てて再試行する(常時捨てると本編側が削れるため)
        args.push('-ss', String(seek));
    }
    // チャンネル切り替え直後は前番組のPAT/PMTの残骸が先頭に混ざるため、長めにprobeしてから構成を確定させる
    args.push('-analyzeduration', '15000000', '-probesize', '30000000');
    args.push('-i', input);
    if (options.chaptersFile != null) {
        // CM位置をチャプターとして持たせる。ファイルは切らないので誤検出しても本編は失われない
        args.push('-i', options.chaptersFile, '-map_chapters', '1');
    }
    // mapで解決できない(型が不明な)ストリームは黙ってスキップする。エンコード自体を止めないため
    args.push('-ignore_unknown');
    // 字幕ストリーム設定(?は字幕ストリームが無い録画でもエンコードが失敗しないようにするため)
    args.push('-map', '0:s?', '-c:s', 'dvbsub');
    // インタレ解除(bwdifはyadifよりコーミング残りが少ない。modeは既定のsend_fieldのままにし、
    // フィールドごとに1フレーム生成して59.94p出力にする)
    args.push('-vf', video.filter);
    // ビデオストリーム設定(?はラジオ相当の映像なし録画でも失敗しないようにするため)
    args.push('-map', '0:v?', '-c:v', ...video.encoder);

    if (audioType === DUAL_MONO) {
        // 副音声は2ヶ国語放送(外国語)の場合と解説放送(日本語の音声ガイド)の場合があり判別できないため言語はundにする。
        // channelsplitの出力はFL/FRという位置情報付き1chレイアウトのままだとlibopusが受け付けないため、aformatでmonoに付け替える
        args.push(
            '-filter_complex',
            'channelsplit[FL][FR];[FL]aformat=channel_layouts=mono[FLm];[FR]aformat=channel_layouts=mono[FRm]',
            '-map',
            '[FLm]',
            '-map',
            '[FRm]',
            '-metadata:s:a:0',
            'language=jpn',
            '-metadata:s:a:1',
            'language=und',
        );
    } else {
        // 音声ストリームを全て拾う(多言語放送等で複数トラックある場合に備える)
        args.push('-map', '0:a');
    }
    args.push('-c:a', 'libopus', '-b:a', '256k'); // 元放送(AAC 256kbps)と同じビットレート

    // トラックのdefaultフラグを明示(未設定だとプレイヤーが自動選択せず字幕/音声が出ないことがある)
    args.push('-disposition:s:0', 'default', '-disposition:v:0', 'default', '-disposition:a:0', 'default');
    // 進捗を key=value 形式で標準出力に吐かせる。stderr の人間向けログを目視パースするより確実
    args.push('-progress', 'pipe:1');
    args.push(output);

    return args;
}

/**
 * CM実カット版の引数。
 *
 * select は「元の時刻 t」で判定するので、bwdif の後・エンコードの前に挟む。
 * 字幕は別ストリームのままだと切った後の時刻に追従できずズレるため落とす
 * (焼き込みに変える手もあるが、字幕を消せなくなるほうが不便という判断)。
 */
/**
 * CM を切り落としたTSを作る。
 *
 * エンコードのフィルタで切っていた頃は、字幕(ARIB字幕)のタイミングを
 * 追従させられず落とすしかなかった。先にTSの段階で切ってしまえば、
 * あとは普通にエンコードするだけで字幕もそのまま残る(消せる字幕のまま)。
 *
 * 残す区間を1つずつ `-c copy` で切り出し、concat デマクサで繋ぐ。
 * 再エンコードしないので速く、字幕もデータ放送も落ちない。
 * キーフレーム単位の切り出しになるが、日本の地上波の MPEG-2 は GOP が
 * 0.5 秒程度なので CM検出の許容誤差 (CM_TOLERANCE) に収まる。
 */
export function buildSegmentArgs(input: string, output: string, range: Range): string[] {
    return [
        '-y',
        '-analyzeduration',
        '15000000',
        '-probesize',
        '30000000',
        // -ss を -i の前に置くと、キーフレームまで飛んでから読み始めるので速い
        '-ss',
        String(range.start),
        '-to',
        String(range.end),
        '-i',
        input,
        '-ignore_unknown',
        '-c',
        'copy',
        '-f',
        'mpegts',
        output,
    ];
}

export function buildConcatArgs(listFile: string, output: string): string[] {
    return [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-ignore_unknown',
        '-c',
        'copy',
        // 切れ目で時刻が飛ぶので振り直す。振り直さないとエンコード側が長さを誤る
        '-fflags',
        '+genpts',
        '-f',
        'mpegts',
        output,
    ];
}

/** concat デマクサに渡す一覧。パスの ' はエスケープが要る */
export function concatList(parts: string[]): string {
    return parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join('\n');
}

export function enqueue(recordingId: number): number {
    const existing = queryOne<{ id: number }>(
        `SELECT id FROM encode_jobs WHERE recording_id = ? AND state IN ('queued','running')`,
        recordingId,
    );
    if (existing !== undefined) return existing.id;

    const info = database()
        .prepare(`INSERT INTO encode_jobs (recording_id, state, created_at) VALUES (?, 'queued', ?)`)
        .run(recordingId, now());
    return Number(info.lastInsertRowid);
}

export function cancel(jobId: number): void {
    canceled.add(jobId);
    const proc = procs.get(jobId);
    if (proc !== undefined) {
        proc.kill();
        return;
    }
    database()
        .prepare(
            `UPDATE encode_jobs SET state = 'canceled', finished_at = ? WHERE id = ? AND state = 'queued'`,
        )
        .run(now(), jobId);
}

interface Progress {
    percent: number;
    log: string;
}

/**
 * `-progress pipe:1` が吐く key=value ブロックを1ブロック分解釈する。
 * out_time_us が N/A になる瞬間(バッファflush中)は percent を更新せず直前値を保つ。
 */
export function parseProgressBlock(
    block: Record<string, string>,
    durationSec: number,
    prev: number,
): Progress {
    const outTimeUs = parseFloat(block.out_time_us);
    let percent = prev;
    if (block.progress === 'end') {
        percent = 1;
    } else if (Number.isFinite(outTimeUs) && Number.isFinite(durationSec) && durationSec > 0) {
        // percent は NaN 汚染を防ぐガードが要る (JSON上 typeof NaN === 'number' で素通りするため)
        percent = Math.min(1, outTimeUs / 1e6 / durationSec);
    }
    const elapsedMin = (outTimeUs / 1e6 / 60).toFixed(2);
    const totalMin = (durationSec / 60).toFixed(2);
    const sizeMb = (parseInt(block.total_size, 10) / 1024 / 1024).toFixed(1);
    const rateMbps = (parseFloat(block.bitrate) / 1000).toFixed(2);
    return {
        percent,
        log: `elapsed: ${elapsedMin}min / ${totalMin}min, speed: ${block.speed}, size: ${sizeMb}MB, rate: ${rateMbps}Mbps, drop: ${block.drop_frames}`,
    };
}

const DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;

/**
 * 失敗の理由を stderr から拾う。
 *
 * 末尾をそのまま切り出すと、ARIB字幕まわりの「オプションが使われなかった」といった
 * 警告ばかりが残って肝心の理由が見えない。エラーらしい行を優先して残す。
 */
export function failureReason(stderr: string): string {
    const lines = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const errors = lines.filter((line) =>
        /error|invalid|failed|no such file|permission denied|not supported|unable to|conversion failed/i.test(
            line,
        ),
    );
    const picked = errors.length > 0 ? errors : lines;
    return picked.slice(-8).join('\n').slice(-2000);
}

async function runFfmpeg(
    job: EncodeJob,
    input: string,
    output: string,
    audioType: number | null,
    seek: number | null,
    codec: VideoCodec,
    options: EncodeOptions = {},
) {
    const proc = Bun.spawn([config.ffmpeg, ...buildArgs(input, output, audioType, seek, codec, options)], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    procs.set(job.id, proc);

    let durationSec = NaN;
    // 出力し終えた時点の位置。CMを切ると入力より短くなるので、出来上がりの長さはこちら
    let outTimeUs = NaN;
    let percent = 0;
    let log = '';
    let lastWrite = 0;
    let stderrTail = '';

    const updateProgress = database().prepare('UPDATE encode_jobs SET percent = ?, log = ? WHERE id = ?');

    // 動画長は ffprobe を別に叩くとチャンネル切替直後のTSでハングして巻き込まれるため、
    // ffmpeg 自身が起動時に stderr へ出す "Duration:" 行から取る
    const readStderr = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of chunks(proc.stderr as ReadableStream<Uint8Array>)) {
            stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-4000);
            if (!Number.isFinite(durationSec)) {
                const m = stderrTail.match(DURATION);
                if (m !== null) {
                    durationSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
                }
            }
        }
    })();

    const readStdout = (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        let block: Record<string, string> = {};
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const eq = line.indexOf('=');
                if (eq === -1) continue;
                block[line.slice(0, eq)] = line.slice(eq + 1).trim();
                if (block.progress === undefined) continue;

                const at = Number(block.out_time_us);
                if (Number.isFinite(at) && at > 0) outTimeUs = at;

                const p = parseProgressBlock(block, durationSec, percent);
                percent = p.percent;
                log = p.log;
                block = {};

                const wroteAt = Date.now();
                if (wroteAt - lastWrite >= PROGRESS_INTERVAL) {
                    lastWrite = wroteAt;
                    updateProgress.run(percent, log, job.id);
                }
            }
        }
    })();

    const [code] = await Promise.all([proc.exited, readStdout, readStderr]);
    procs.delete(job.id);
    updateProgress.run(code === 0 ? 1 : percent, log, job.id);
    return { code, stderrTail: failureReason(stderrTail), outTimeUs };
}

/**
 * エンコード前のCM検出。cm_cut の設定に応じて、実カット用の残す区間か
 * チャプター用の ffmetadata を用意する。検出できなかった場合は素通し。
 */
async function prepareCm(
    jobId: number,
    recording: Recording,
    input: string,
): Promise<EncodeOptions & { chaptersFile: string | null }> {
    const none = { keep: null, chaptersFile: null };
    if (recording.cm_cut === 'off') return none;

    database().prepare('UPDATE encode_jobs SET log = ? WHERE id = ?').run('CM検出中...', jobId);

    let detection: CmDetection;
    try {
        detection = await detectCm(input);
    } catch (error) {
        console.error(`[cm] 検出に失敗したためCM処理をスキップします: ${error}`);
        return none;
    }

    database()
        .prepare('UPDATE recordings SET cm_ranges = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(detection.cm), now(), recording.id);
    database()
        .prepare('UPDATE encode_jobs SET log = ? WHERE id = ?')
        .run(`CM ${detection.cm.length} 箇所 (${detection.note})`, jobId);
    if (detection.cm.length === 0) return none;

    if (recording.cm_cut === 'cut') {
        return { keep: keepRanges(detection.cm, detection.duration), chaptersFile: null };
    }

    const chaptersFile = `${input}.chapters.txt`;
    writeFileSync(chaptersFile, chapterMetadata(detection.cm, detection.duration));
    return { keep: null, chaptersFile };
}

/** ffmpeg を1回動かす。戻り値は終了コード */
async function runOnce(args: string[]): Promise<number> {
    const proc = Bun.spawn([config.ffmpeg, ...args], { stdout: 'ignore', stderr: 'pipe' });
    return await proc.exited;
}

/**
 * CM を切り落としたTSを作って、そのパスを返す。作れなければ null。
 * 元のTSはそのまま残す(切り方を間違えても録画は失われない)。
 */
async function trimCm(jobId: number, input: string, keep: Range[]): Promise<string | null> {
    database().prepare('UPDATE encode_jobs SET log = ? WHERE id = ?').run('CMを切っています...', jobId);

    const parts: string[] = [];
    try {
        for (const [i, range] of keep.entries()) {
            const part = `${input}.part${i}.ts`;
            const code = await runOnce(buildSegmentArgs(input, part, range));
            if (code !== 0 || !existsSync(part)) throw new Error(`区間 ${i} の切り出しに失敗しました`);
            parts.push(part);
        }

        const listFile = `${input}.concat.txt`;
        const trimmed = `${input}.cut.ts`;
        writeFileSync(listFile, concatList(parts));
        const code = await runOnce(buildConcatArgs(listFile, trimmed));
        rmSync(listFile, { force: true });
        if (code !== 0 || !existsSync(trimmed)) throw new Error('繋ぎ直しに失敗しました');
        return trimmed;
    } catch (error) {
        // 切れなかったらCMを残したままエンコードする。録れているものを捨てない
        console.error(`[cm] ${error}。CMを残したままエンコードします`);
        return null;
    } finally {
        for (const part of parts) rmSync(part, { force: true });
    }
}

/**
 * エンコードの元にできるファイル。
 *
 * 生TSがあればそれ。無ければ保存先にあるものを使う。引き継いだ録画は
 * 生TSを持たず、中身がまだ生TSのまま「視聴可能」になっていることがある
 * (EPGStation 側でエンコードが済んでいなかったもの)。
 */
export function encodeSource(recording: Recording): string | null {
    return recording.ts_path ?? recording.library_path;
}

/** エンコードの失敗を記録して知らせる。理由はそのまま録画の行に出る */
function fail(jobId: number, recording: Recording, reason: string): void {
    database()
        .prepare(`UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(reason, now(), jobId);
    database()
        .prepare(`UPDATE recordings SET state = 'failed', error = ?, updated_at = ? WHERE id = ?`)
        .run('エンコードに失敗しました', now(), recording.id);
    emit('recordings');
    notify({
        event: 'encode.failed',
        text: `エンコードに失敗しました: ${recording.name} (${recording.service_name})`,
        recording: {
            id: recording.id,
            name: recording.name,
            service: recording.service_name,
            startAt: recording.start_at,
            endAt: recording.end_at,
        },
        error: reason,
    });
}

async function runJob(jobId: number): Promise<void> {
    const job = queryOne<EncodeJob>('SELECT * FROM encode_jobs WHERE id = ?', jobId)!;
    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', job.recording_id);
    const input = recording === undefined ? null : encodeSource(recording);

    if (recording === undefined || input === null) {
        database()
            .prepare(`UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`)
            .run('元の録画ファイルが見つかりません', now(), jobId);
        return;
    }

    database()
        .prepare(`UPDATE recordings SET state = 'encoding', updated_at = ? WHERE id = ?`)
        .run(now(), recording.id);

    const output = libraryPath(recording, '.mkv');
    mkdirSync(dirname(output), { recursive: true });

    /*
     * いったん別名に書いてから置き換える。
     * 引き継いだ録画を録り直すと入力と出力が同じ場所になることがあり、
     * そのまま書くと元を壊す。失敗したときに元が消えないのも同じ理由
     */
    const working = `${output}.encoding`;

    /*
     * スクランブルが掛かったまま録れていたら、ここで解く。
     *
     * カードが読めないとき録画を止めてしまうと電波は二度と戻ってこないので、
     * 録画自体は暗号のままでも残す方針にしてある。解くのはこの時点でよい。
     * 解くのは Mirakurun 側(カードを持っているのはあちら)。
     */
    /** 後始末で消す作業ファイル。生TSを置き換えたときは残す側になるので null のまま */
    let decoded: string | null = null;
    let sourceTs = input;
    if (isScrambled(input)) {
        database().prepare('UPDATE encode_jobs SET log = ? WHERE id = ?').run('スクランブル解除中...', jobId);
        const target = `${input}.decoded.ts`;
        const result = await descramble(input, target);
        if (!result.ok) {
            removeIfExists(target);
            fail(jobId, recording, `スクランブルを解除できませんでした: ${result.error}`);
            return;
        }
        if (recording.keep_original && recording.ts_path === input) {
            // 生TSを残す設定なら、残すのは解けたほうだけにする。
            // 掛かったままのTSを取っておいても、あとから解ける保証は無い
            renameSync(target, input);
        } else {
            decoded = target;
            sourceTs = target;
        }
    }

    const encodeOptions = await prepareCm(jobId, recording, sourceTs);

    // CMを実際に切る場合は、エンコードの前にTSの段階で切っておく。
    // エンコードのフィルタで切ると字幕のタイミングを追従させられず落とすことになる
    let source = sourceTs;
    let trimmed: string | null = null;
    const keep = encodeOptions.keep ?? null;
    if (keep !== null && keep.length > 0) {
        trimmed = await trimCm(jobId, sourceTs, keep);
        if (trimmed !== null) source = trimmed;
    }

    let result = await runFfmpeg(
        job,
        source,
        working,
        recording.audio_type,
        null,
        recording.codec,
        encodeOptions,
    );
    if (result.code !== 0 && !canceled.has(jobId)) {
        // 録画開始直後の頭数百msだけ壊れているケースをここで拾う(詳細は buildArgs のコメント参照)。
        // 別の理由での失敗もここに来るが、-ss を付けても同じ理由でもう一度失敗するだけなので無害
        database().prepare('UPDATE encode_jobs SET attempts = attempts + 1 WHERE id = ?').run(jobId);
        result = await runFfmpeg(
            job,
            source,
            working,
            recording.audio_type,
            config.encodeRetrySeek,
            recording.codec,
            encodeOptions,
        );
    }

    removeIfExists(encodeOptions.chaptersFile);
    // CMを切ったTSも解除したTSも作業用。元のTSは残したままなので、やり直せる
    removeIfExists(trimmed);
    removeIfExists(decoded);

    if (canceled.has(jobId)) {
        // 出来かけを捨てるだけ。元のファイルには触らない
        removeIfExists(working);
        database()
            .prepare(`UPDATE encode_jobs SET state = 'canceled', finished_at = ? WHERE id = ?`)
            .run(now(), jobId);
        database()
            .prepare(`UPDATE recordings SET state = 'recorded', updated_at = ? WHERE id = ?`)
            .run(now(), recording.id);
        return;
    }

    if (result.code !== 0) {
        removeIfExists(working);
        fail(jobId, recording, result.stderrTail);
        return;
    }

    // ここで初めて本来の場所に置く。引き継いだ録画の録り直しでは元を上書きする
    renameSync(working, output);

    let size = 0;
    try {
        size = statSync(output).size;
    } catch {
        // 取れなくても致命的ではない
    }

    // 出来上がりの長さで上書きする。CMを切っていれば元のTSより短い
    if (Number.isFinite(result.outTimeUs) && result.outTimeUs > 0) {
        database()
            .prepare('UPDATE recordings SET duration_ms = ? WHERE id = ?')
            .run(Math.round(result.outTimeUs / 1000), recording.id);
    }

    // 番組名・概要・放送日・サムネイルをサイドカーに書く。動画を置いた直後に作る
    writeNfo(recording, output);
    await writeThumbnail(output, (recording.end_at - recording.start_at) / 1000);

    database()
        .prepare(`UPDATE encode_jobs SET state = 'done', percent = 1, finished_at = ? WHERE id = ?`)
        .run(now(), jobId);
    emit('recordings');
    notify({
        event: 'encode.finished',
        text: `エンコードが終わりました: ${recording.name} (${recording.service_name})`,
        recording: {
            id: recording.id,
            name: recording.name,
            service: recording.service_name,
            startAt: recording.start_at,
            endAt: recording.end_at,
        },
    });

    if (recording.keep_original) {
        database()
            .prepare(
                `UPDATE recordings SET state = 'available', library_path = ?, ts_size = ?, updated_at = ? WHERE id = ?`,
            )
            .run(output, size, now(), recording.id);
    } else {
        // 生TSを持たない引き継ぎ分では消すものが無い
        removeIfExists(recording.ts_path);
        database()
            .prepare(
                `UPDATE recordings SET state = 'available', library_path = ?, ts_path = NULL, ts_size = ?, updated_at = ? WHERE id = ?`,
            )
            .run(output, size, now(), recording.id);
    }
}

/** 同時実行数の空きぶんだけキューを消化する。録画完了時と定期tickの両方から呼ばれる */
export function pump(): void {
    while (runningJobs.size < config.encodeConcurrency) {
        const next = queryOne<{ id: number }>(
            `SELECT id FROM encode_jobs WHERE state = 'queued' ORDER BY id LIMIT 1`,
        );
        if (next === undefined) return;

        // 実際に走り出す前に状態を進めておく。次のループが同じジョブを拾わないため
        const claimed = database()
            .prepare(
                `UPDATE encode_jobs SET state = 'running', started_at = ?, attempts = attempts + 1
                 WHERE id = ? AND state = 'queued'`,
            )
            .run(now(), next.id);
        if (claimed.changes === 0) return;

        const jobId = next.id;
        runningJobs.add(jobId);
        void runJob(jobId)
            .catch((error) => {
                database()
                    .prepare(
                        `UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`,
                    )
                    .run(String(error), now(), jobId);
            })
            .finally(() => {
                runningJobs.delete(jobId);
                procs.delete(jobId);
                canceled.delete(jobId);
                // 空いた枠に次のジョブを入れる
                pump();
            });
    }
}

/**
 * 落ちた時点で running だったジョブを queued に戻す。
 * ffmpeg は親と一緒に死んでいるので、出力を捨てて頭からやり直す。
 */
export function requeueOrphanedJobs(): number {
    return database()
        .prepare(
            `UPDATE encode_jobs SET state = 'queued', percent = 0, started_at = NULL WHERE state = 'running'`,
        )
        .run().changes;
}
