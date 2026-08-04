import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeSource } from '../source';
import type { EncodeJob, EncodePhase, Recording, VideoCodec } from '../types';
import {
    type CmDetection,
    chapterMetadata,
    detectCm,
    invertRanges,
    probeVideo,
    type Range,
    widenKeep,
} from './cm';
import { config } from './config';
import { database, now, queryOne } from './db';
import { emit } from './events';
import { removeIfExists } from './fsx';
import { libraryPath } from './library';
import { sidecarPaths, writeNfo, writeThumbnail } from './metadata';
import { descramble, isScrambled } from './scramble';
import { settings } from './settings';
import { chunks } from './stream';
import { buildPgs } from './subtitle';
import { notify } from './webhook';

export function isVideoCodec(value: unknown): value is VideoCodec {
    return value === 'av1' || value === 'h264' || value === 'none';
}

/**
 * 映像コーデックごとの設定。
 * AV1 は同じ画質でファイルが小さいがエンコードが遅い。非力なマシンでは h264 を選ぶ。
 * H.264 は 8bit にしておく(10bit を再生できないクライアントが残っているため)。
 */
/**
 * インタレ解除の出し方。
 *
 * `bwdif` の既定は `send_field` で、**1フィールドから1コマ作って 59.94p にする**。
 * 放送は 1080i (毎秒60フィールド) なので、実写・スポーツ・報道はこれで
 * 撮られたとおりの動きになる。コマ数が倍なのでエンコードの時間もサイズも
 * およそ倍になる (実測・地上波1分・AV1 10bit: 31.8秒 26MB ↔ 16.9秒 15MB)。
 *
 * **国内アニメだけは倍にしない。** 元が毎秒24コマ前後で描かれていて、それを
 * プルダウンして60フィールドに乗せているだけなので、フィールドごとにコマを
 * 起こしても同じ絵が並ぶだけになる。滑らかさは1つも増えず、時間とサイズだけ倍になる。
 */
function deinterlace(smooth: boolean): string {
    return smooth ? 'bwdif' : 'bwdif=mode=send_frame';
}

/**
 * 国内アニメ (ARIB の大分類 7 / 中分類 0)。
 *
 * 同じ大分類でも、**海外アニメ (中分類 1) と特撮 (中分類 2) は倍にする。**
 * 海外のものは毎秒30コマで作られていることが多く、特撮は実写なので
 * もともと60フィールドぶんの動きが入っている。大分類だけで切っていた頃は
 * この2つまで30コマに落としていた。
 */
const GENRE_ANIME = 7;
const SUBGENRE_ANIME_JP = 0;

/**
 * その録画を 60コマ/秒 で出すか。
 *
 * 番組表から写したジャンル (中分類まで) で決める。ジャンルが分からない録画
 * (引き継いだもの、番組情報の無い放送) は実写として扱う — 放送の大半は実写で、
 * アニメを実写扱いにしても絵は変わらない (無駄が出るだけ) が、逆は動きが落ちる。
 */
export function smoothMotionFor(genreDetail: string | null): boolean {
    if (genreDetail === null || genreDetail === '') return true;
    try {
        const parsed = JSON.parse(genreDetail) as unknown;
        if (!Array.isArray(parsed)) return true;
        return !parsed.some(
            (genre) =>
                Number((genre as { lv1?: unknown }).lv1) === GENRE_ANIME &&
                Number((genre as { lv2?: unknown }).lv2) === SUBGENRE_ANIME_JP,
        );
    } catch {
        return true;
    }
}

/**
 * 実際にエンコードに使うコーデック。
 *
 * 録画の行に `none` (エンコードしない) が入っていることがある。あとから
 * 「再エンコード」を押したときは、そのときの設定で焼く — 押した人は
 * 焼きたいのであって、録ったときの設定を再現したいわけではない。
 * 設定まで `none` なら、そもそも焼くものが決まらないので断る (enqueue 側)
 */
function resolveCodec(codec: VideoCodec): 'av1' | 'h264' {
    if (codec === 'av1' || codec === 'h264') return codec;
    const chosen = settings().codec;
    return chosen === 'none' ? 'av1' : chosen;
}

/**
 * **画素を正方形に直す。**
 *
 * 地上波のHDは 1440x1080 で送られてきて、画素が横長 (SAR 4:3) であることを
 * 別に添えて 16:9 に見せている。ffmpeg はその添え書きをそのまま写すので、
 * 出来上がりも 1440x1080 + SAR 4:3 になる。
 *
 * ところが**添え書きを見ないプレイヤーがある。** Android の VLC は
 * ハードウェア再生のとき画素の数だけを見るので、4:3 に潰れて出る (実機で確認)。
 *
 * **大きさはこちらで測って渡す** (`probeVideo` の width と sar)。
 * `scale=trunc(iw*sar/2)*2` のように ffmpeg の式で書くと、SAR が読めない
 * 素材で `sar` が 0 になり、幅 0 で落ちる。数で渡せばその目はない
 */
function squarePixels(size: { width: number; height: number } | undefined): string | null {
    if (size === undefined) return null;
    return `scale=${size.width}:${size.height},setsar=1`;
}

function videoArgs(
    codec: 'av1' | 'h264',
    smooth: boolean,
    scale: string | null,
): { filter: string; encoder: string[] } {
    const steps = [deinterlace(smooth), ...(scale === null ? [] : [scale])];
    if (codec === 'h264') {
        return {
            filter: [...steps, 'format=yuv420p'].join(','),
            // 実測で AV1 とほぼ同じ速さ。SVT-AV1 の既定より遅い preset を
            // 指定すると逆に倍かかるので、どちらも既定のままにしてある
            encoder: ['libx264', '-preset', 'medium', '-crf', '22'],
        };
    }
    return { filter: [...steps, 'format=yuv420p10le'].join(','), encoder: ['libsvtav1'] };
}

const DUAL_MONO = 2;

/**
 * 字幕に使うフォント。
 */
const SUBTITLE_FONTS = 'Rounded M+ 1m for ARIB';
/** 進捗をDBに書き戻す間隔。1フレームごとに書くとWAL肥大とUIのちらつきの原因になる */
const PROGRESS_INTERVAL = 2000;

/** 同時実行数を数えるための実行中ジョブID。ffmpeg の起動前から入る */
const runningJobs = new Set<number>();
/** kill 用。ffmpeg が起動している間だけ入る */
const procs = new Map<number, Bun.Subprocess>();
/**
 * 中止の合図。ジョブが走っている間ずっとある。
 *
 * ffmpeg を kill するだけでは足りない。スクランブル解除は向こうの
 * コンテナへの HTTP、CM検出は別の ffmpeg で、どちらも数十分かかることがある。
 * 「中止を押したのに何も起きない」を無くすため、段階ごとにこれを渡す
 */
const aborts = new Map<number, AbortController>();
/** ユーザーが止めたジョブ。失敗と区別して再試行しないため */
const canceled = new Set<number>();

export interface EncodeOptions {
    /**
     * CM実カット時に残す区間。null なら全部残す。
     * 切るのは buildSegmentArgs 側で、buildArgs はこれを見ない
     */
    keep?: Range[] | null;
    /** チャプター(CM位置)を書き込む ffmetadata ファイル */
    chaptersFile?: string | null;
    /** 60コマ/秒で出す。滑らかになる代わりに時間もサイズも約2倍 (smoothMotionFor) */
    smoothMotion?: boolean;
    /**
     * 字幕を絵にするときの画面の大きさ ("1920x1080")。無ければ 1440x1080 とみなされる。
     * 使うのは .sup を作る側 (buildPgs) で、buildArgs はこれを見ない
     */
    canvasSize?: string;
    /**
     * 放送どおりに描いた字幕を入れた PGS (.sup)。
     * denpa が別に作って渡す (src/lib/server/subtitle.ts)。無ければ字幕は入らない
     */
    pgsFile?: string | null;
    /**
     * 映像が始まるまでの間(秒)。**出来上がりの映像を 0 秒から始めるために引く。**
     *
     * TS は音声のほうが先に始まっていることが多く、実機の録画では映像の1コマ目が
     * 0.667 秒あとだった。そのまま焼くと出来上がりの映像も 0.667 秒から始まる。
     * 時刻をそのまま読むプレイヤーなら合っているが、**1コマ目を 0 秒として数える
     * プレイヤー**ではそのぶん字幕が早く出る (実機で「字幕が少し早い」として出た)
     */
    videoStart?: number;
    /**
     * 正方形の画素で出したときの大きさ。**渡されたときだけ引き伸ばす。**
     * 1440x1080 (SAR 4:3) なら 1920x1080。もともと正方形の素材では渡さない
     */
    displaySize?: { width: number; height: number };
}

/**
 * ffmpeg の引数。EPGStation 時代の enc.js をそのまま移植したもので、
 * 各フラグの理由はコメントに残してある(ARIB字幕の焼き込み、インタレ解除、デュアルモノ分離)。
 *
 * CM を切る場合でもここは変わらない。**切るのはエンコードの前にTSの段階**で、
 * ここに来る入力は既に切り終えたものになっている (buildSegmentArgs)。
 */
export function buildArgs(
    input: string,
    output: string,
    audioType: number | null,
    seek: number | null,
    codec: VideoCodec = 'av1',
    options: EncodeOptions = {},
): string[] {
    const video = videoArgs(
        resolveCodec(codec),
        options.smoothMotion === true,
        squarePixels(options.displaySize),
    );

    const args = ['-y'];

    if (seek !== null) {
        // 録画開始直後の1秒未満だけ、多重化されたもう一方の映像ストリームのPAT/PMTが確定しておらず
        // エンコーダの初期化(fps/解像度確定)自体が失敗することがある。
        // 最初の失敗を検知した後だけ頭を少し捨てて再試行する(常時捨てると本編側が削れるため)
        args.push('-ss', String(seek));
    }
    // チャンネル切り替え直後は前番組のPAT/PMTの残骸が先頭に混ざるため、長めにprobeしてから構成を確定させる
    args.push('-analyzeduration', '15000000', '-probesize', '30000000');
    args.push('-i', input);

    /*
     * 字幕は**PGS 1本だけ**。denpa が別に作った .sup をそのまま copy する
     * (作り方は subtitle.ts、なぜ PGS だけかは docs/architecture.md)。
     * 作れなかったとき (字幕の無い番組・sub2video が落ちた場合) は字幕トラックが入らない
     */
    let next = 1;
    let pgs = -1;
    if (options.pgsFile != null) {
        pgs = next++;
        args.push('-i', options.pgsFile);
    }
    if (options.chaptersFile != null) {
        // CM位置をチャプターとして持たせる。ファイルは切らないので誤検出しても本編は失われない
        args.push('-i', options.chaptersFile, '-map_chapters', String(next++));
    }
    // mapで解決できない(型が不明な)ストリームは黙ってスキップする。エンコード自体を止めないため
    args.push('-ignore_unknown');
    // 字幕。?は .sup が空だった場合でもエンコードを止めないため
    if (pgs >= 0) {
        args.push('-map', `${pgs}:s:0?`, '-c:s:0', 'copy', '-metadata:s:s:0', 'title=字幕');
        args.push('-disposition:s:0', 'default');
    }
    // インタレ解除 (bwdif は yadif よりコーミング残りが少ない)。
    // なめらかさの指定でコマ数が変わる (videoArgs)
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

    // トラックのdefaultフラグを明示(未設定だとプレイヤーが自動選択せず音声が出ないことがある。
    // 字幕は上で入れたときだけ立てる)
    args.push('-disposition:v:0', 'default', '-disposition:a:0', 'default');
    /*
     * **映像を 0 秒から始める。**
     *
     * 音声のほうが先に始まっている TS では、そのまま焼くと映像も途中から
     * 始まる (実機で 0.667 秒)。1コマ目を 0 秒として数えるプレイヤーでは
     * そのぶん字幕だけが早く出る。全部のトラックを同じだけ前へ寄せれば、
     * どちらの数え方でも合う (前へ出すぎた頭は入れ物側で 0 に詰められる)
     */
    const start = options.videoStart ?? 0;
    if (start > 0.05) args.push('-output_ts_offset', String(-start));

    // 進捗を key=value 形式で標準出力に吐かせる。stderr の人間向けログを目視パースするより確実
    args.push('-progress', 'pipe:1');
    /*
     * 入れ物は名前ではなくここで決める。出力は書いている間だけ別名 (.mkv.encoding) にしており、
     * ffmpeg は拡張子から入れ物を決めるので、付けないと
     * 「Unable to choose an output format」で始まる前に落ちる
     */
    args.push('-f', 'matroska');
    args.push(output);

    return args;
}

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
 * 0.5 秒程度なので CM検出の許容誤差 (config.cmTolerance) に収まる。
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
    // どの段階に居ても止まるようにする。ffmpeg が回っていない段階もある
    aborts.get(jobId)?.abort();
    procs.get(jobId)?.kill();

    const stopped = database()
        .prepare(
            `UPDATE encode_jobs SET state = 'canceled', finished_at = ? WHERE id = ? AND state = 'queued'`,
        )
        .run(now(), jobId);
    // まだ始まっていなければここで終わり。走っている分は runJob が後始末して知らせる
    if (stopped.changes > 0) emit('recordings');
}

/** 段階を進めて画面にも伝える。押しても反応が無いように見えるのを防ぐ */
function setPhase(jobId: number, phase: EncodePhase, log: string): void {
    database()
        .prepare('UPDATE encode_jobs SET phase = ?, log = ?, percent = 0, eta_ms = NULL WHERE id = ?')
        .run(phase, log, jobId);
    emit('recordings');
}

/**
 * 段階の中で「いま何をしているか」だけ書き換える。
 *
 * CM検出は中で3つの道具を順に回していて、どれも数分かかる。段階の名前
 * (「CM検出中」) だけでは、進んでいるのか止まっているのかが分からなかった。
 */
function setStep(jobId: number, log: string): void {
    database().prepare('UPDATE encode_jobs SET log = ? WHERE id = ?').run(log, jobId);
    emit('recordings');
}

/**
 * 段階の中の進み具合。エンコード以外の段階でも出せるところは出す。
 *
 * 書き戻しはエンコード中と同じ間隔まで。細かく書くと WAL が膨らむだけで、
 * 画面のほうも追いつかない。
 */
function progressReporter(jobId: number): (percent: number) => void {
    const update = database().prepare('UPDATE encode_jobs SET percent = ? WHERE id = ?');
    let lastWrite = 0;
    return (percent) => {
        const at = Date.now();
        if (at - lastWrite < PROGRESS_INTERVAL) return;
        lastWrite = at;
        update.run(Math.min(1, Math.max(0, percent)), jobId);
        emit('recordings');
    };
}

interface Progress {
    percent: number;
    /** 残り時間の見込み(ms)。速さが読めないうちは null */
    etaMs: number | null;
    log: string;
}

/**
 * `-progress pipe:1` が吐く key=value ブロックを1ブロック分解釈する。
 *
 * **`out_time_us` は当てにならない。** 分かっているだけで2通りの外し方をする。
 *
 * - **`N/A` が続く。** AV1 (libsvtav1) は先読みを溜めてから出し始めるので、
 *   その間ずっと読めない。実機の30分番組では最初の数分がまるごとこれだった
 * - **途中で止まる。** ffmpeg が出すのは**いちばん後ろのストリームの時刻**で、
 *   壊れた副音声が1本混ざっているとそこで止まる。実機の TOKYO MX の録画は
 *   `Packet corrupt (stream = 3)` のあと **8.576 秒のまま**動かず、
 *   30分焼き終わっても 0% のままだった (出来上がりは 30分ぶん正しく入っていた)
 *
 * そこで **`frame=`** と突き合わせて、**進んでいるほうを採る**。コマ数は
 * 最初から increment するので、少なくとも止まって見えることはない。総フレーム数は
 * 尺×出力fps (インタレ解除で倍になる) の見積もりなので、単独では当てにしない。
 */
export function parseProgressBlock(
    block: Record<string, string>,
    durationSec: number,
    prev: number,
    totalFrames = NaN,
): Progress {
    const outTimeUs = parseFloat(block.out_time_us);
    const frame = parseFloat(block.frame);
    // percent は NaN 汚染を防ぐガードが要る (JSON上 typeof NaN === 'number' で素通りするため)
    const measurable = (value: number) => Number.isFinite(value) && value > 0;

    const byTime =
        Number.isFinite(outTimeUs) && measurable(durationSec)
            ? Math.min(1, outTimeUs / 1e6 / durationSec)
            : 0;
    const byFrame = Number.isFinite(frame) && measurable(totalFrames) ? Math.min(1, frame / totalFrames) : 0;
    /*
     * **前の値より下げない。** 時刻とコマ数のどちらを採るかが途中で入れ替わるので、
     * 素直に書くと割合が巻き戻る
     */
    const percent = block.progress === 'end' ? 1 : Math.max(prev, byTime, byFrame);

    /*
     * 残り時間。**割合を出したのと同じ出どころで見積もる** — 時刻が止まっている
     * のに `speed` (これも時刻から出る) で割ると、5倍速で焼けているものが
     * 「残り20時間」になる。
     *
     * 時刻が読めているときは ffmpeg の speed (実時間比。"0.85x" のような形) で
     * まだ通していない秒数を割る。AV1 だと 0.1x を切ることもあるので、
     * 割合だけ出しても放っておいていいのか判断できない
     */
    const speed = parseFloat(block.speed);
    const fps = parseFloat(block.fps);
    let etaMs: number | null = null;
    if (byFrame > byTime && measurable(fps) && measurable(totalFrames)) {
        etaMs = Math.round(((totalFrames - frame) / fps) * 1000);
    } else if (measurable(speed) && Number.isFinite(durationSec) && Number.isFinite(outTimeUs)) {
        const leftSec = durationSec - outTimeUs / 1e6;
        if (leftSec > 0) etaMs = Math.round((leftSec / speed) * 1000);
    }

    const elapsedMin = (outTimeUs / 1e6 / 60).toFixed(2);
    const totalMin = (durationSec / 60).toFixed(2);
    const sizeMb = (parseInt(block.total_size, 10) / 1024 / 1024).toFixed(1);
    const rateMbps = (parseFloat(block.bitrate) / 1000).toFixed(2);
    return {
        percent,
        etaMs,
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
    /** 先に測っておいた入力の尺と fps。進み具合の分母になる */
    measured: { duration: number; fps: number } = { duration: NaN, fps: NaN },
) {
    const proc = Bun.spawn([config.ffmpeg, ...buildArgs(input, output, audioType, seek, codec, options)], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    procs.set(job.id, proc);

    // ffmpeg の stderr から拾えるとは限らないので、測った値を先に入れておく
    let durationSec = measured.duration;
    /*
     * 出力フレーム数の見積もり。60コマ/秒で出すときは、インタレ解除が
     * フィールドごとに1枚作るので入力の倍になる
     */
    const totalFrames = measured.duration * measured.fps * (options.smoothMotion === true ? 2 : 1);
    // 出力し終えた時点の位置。CMを切ると入力より短くなるので、出来上がりの長さはこちら
    let outTimeUs = NaN;
    let percent = 0;
    let etaMs: number | null = null;
    let log = '';
    let lastWrite = 0;
    let stderrTail = '';

    const updateProgress = database().prepare(
        'UPDATE encode_jobs SET percent = ?, eta_ms = ?, log = ? WHERE id = ?',
    );

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

                const p = parseProgressBlock(block, durationSec, percent, totalFrames);
                percent = p.percent;
                etaMs = p.etaMs;
                log = p.log;
                block = {};

                const wroteAt = Date.now();
                if (wroteAt - lastWrite >= PROGRESS_INTERVAL) {
                    lastWrite = wroteAt;
                    updateProgress.run(percent, etaMs, log, job.id);
                    // 進み具合を画面にも流す。書き込みと同じ間隔なので、これ以上細かくはならない
                    emit('recordings');
                }
            }
        }
    })();

    const [code] = await Promise.all([proc.exited, readStdout, readStderr]);
    procs.delete(job.id);
    updateProgress.run(code === 0 ? 1 : percent, null, log, job.id);
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
    signal: AbortSignal,
): Promise<EncodeOptions & { chaptersFile: string | null }> {
    const none = { keep: null, chaptersFile: null };
    /*
     * **CMの扱いは焼くときの設定に従う。** 録画の行にも写してあるが、それは
     * 録り始めた時点の値で、設定を変えても直らない (`keepOriginal` は前から
     * 設定を見ている。ここだけ食い違っていた)
     */
    if (settings().cmCut === 'off') return none;

    setPhase(jobId, 'cm', 'CMを探しています');

    let detection: CmDetection;
    try {
        /*
         * ロゴの位置を手で入れてもらっていれば渡す。自動で見つからない局
         * (薄い・動くロゴ) はこれが無いとロゴ無しの判定に落ちる
         */
        const service = queryOne<{ logo_area: string | null }>(
            'SELECT logo_area FROM services WHERE id = ?',
            recording.service_id,
        );
        detection = await detectCm(input, {
            signal,
            channel: recording.service_name,
            serviceId: recording.service_id,
            area: service?.logo_area ?? '',
            onProgress: progressReporter(jobId),
            onStep: (label) => setStep(jobId, label),
        });
    } catch (error) {
        console.error(`[cm] 検出に失敗したためCM処理をスキップします: ${error}`);
        return none;
    }

    /*
     * ロゴを使えたかどうかは覚え書きに書いてある (cm.detectCm)。別の列では持たない。
     * 持っていた頃は、後から「位置を教える口を出す条件」を広げても、既に録ってある
     * 分には効かなかった
     */
    database()
        .prepare('UPDATE recordings SET cm_ranges = ?, cm_note = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(detection.cm), detection.note, now(), recording.id);
    database()
        .prepare('UPDATE encode_jobs SET log = ? WHERE id = ?')
        .run(`CM ${detection.cm.length} 箇所 (${detection.note})`, jobId);
    if (detection.cm.length === 0) return none;

    if (settings().cmCut === 'cut') {
        /*
         * **頭を少し戻してから切る。** 切り出しはキーフレーム単位なので、
         * 判定どおりの位置から始めると本編の頭が1 GOP ぶん削れる (widenKeep)。
         * チャプターにするほうは戻さない — あちらは切らないので、位置は
         * 判定どおりのほうが正しい
         */
        return {
            keep: widenKeep(invertRanges(detection.cm, detection.duration), config.cmCutMargin),
            chaptersFile: null,
        };
    }

    const chaptersFile = `${input}.chapters.txt`;
    writeFileSync(chaptersFile, chapterMetadata(detection.cm, detection.duration));
    return { keep: null, chaptersFile };
}

/** ffmpeg を1回動かす。戻り値は終了コード */
async function runOnce(args: string[], signal: AbortSignal): Promise<number> {
    const proc = Bun.spawn([config.ffmpeg, ...args], { stdout: 'ignore', stderr: 'pipe' });
    const kill = () => proc.kill();
    signal.addEventListener('abort', kill, { once: true });
    try {
        return await proc.exited;
    } finally {
        signal.removeEventListener('abort', kill);
    }
}

/**
 * CM を切り落としたTSを作って、そのパスを返す。作れなければ null。
 * 元のTSはそのまま残す(切り方を間違えても録画は失われない)。
 */
async function trimCm(
    jobId: number,
    input: string,
    keep: Range[],
    signal: AbortSignal,
): Promise<string | null> {
    setPhase(jobId, 'cut', 'CMを切っています');
    // 切るのは区間ごとなので、消化した本数がそのまま進み具合になる
    const report = progressReporter(jobId);

    const parts: string[] = [];
    try {
        for (const [i, range] of keep.entries()) {
            if (signal.aborted) throw new Error('中止されました');
            report(i / (keep.length + 1));
            const part = `${input}.part${i}.ts`;
            const code = await runOnce(buildSegmentArgs(input, part, range), signal);
            if (code !== 0 || !existsSync(part)) throw new Error(`区間 ${i} の切り出しに失敗しました`);
            parts.push(part);
        }

        const listFile = `${input}.concat.txt`;
        const trimmed = `${input}.cut.ts`;
        writeFileSync(listFile, concatList(parts));
        const code = await runOnce(buildConcatArgs(listFile, trimmed), signal);
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
 * 生TSを残すか。
 *
 * 録画ごとの指定ではなく全体設定に従う。録り直すたびに「あのときどうしたか」を
 * 思い出す必要が無いようにするため。
 */
function keepOriginal(): boolean {
    return settings().keepOriginal;
}

/**
 * エンコードの失敗を記録して知らせる。
 *
 * **録画の行には何も書かない。** 落ちたのは焼き直しのほうで、元の録画は無事なので、
 * 録画そのものを「失敗」にすると観られるはずのものが観られなくなる (実際にそうなっていた)。
 * 理由はジョブが持ち、一覧は最新のジョブを見て出す
 */
function fail(jobId: number, recording: Recording, reason: string): void {
    database()
        .prepare(`UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(reason, now(), jobId);
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

/**
 * 中止で終わったときの後始末。
 *
 * 出来かけの作業ファイルだけ捨てて、元の録画には触らない。
 * どの段階で止めても同じ形で畳めるように1か所にまとめてある。
 */
function finishCanceled(jobId: number, working: string | null): void {
    removeIfExists(working);
    database()
        .prepare(`UPDATE encode_jobs SET state = 'canceled', finished_at = ? WHERE id = ?`)
        .run(now(), jobId);
    // 録画の行は触らない。ジョブが消えれば「録画済み」に戻って見える
    emit('recordings');
}

async function runJob(jobId: number): Promise<void> {
    const controller = new AbortController();
    aborts.set(jobId, controller);
    const signal = controller.signal;

    const job = queryOne<EncodeJob>('SELECT * FROM encode_jobs WHERE id = ?', jobId)!;
    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', job.recording_id);
    const input = recording === undefined ? null : encodeSource(recording);

    if (recording === undefined || input === null) {
        database()
            .prepare(`UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`)
            .run('元にできる生TSがありません', now(), jobId);
        return;
    }

    /*
     * 「エンコード中」は録画の行には書かない。動いているジョブがあることが
     * そのまま「エンコード中」なので、一覧はそれを見て出す (format.encodeLabel)。
     * 前の失敗の理由もジョブ側にあり、いちばん新しいジョブだけを見ているので消して回る必要もない
     */
    emit('recordings');

    const output = libraryPath(recording, '.mkv');
    mkdirSync(dirname(output), { recursive: true });

    /*
     * いったん別名に書いてから置き換える。
     * 同じ番組を録り直すと入力と出力が同じ場所になることがあり、
     * そのまま書くと元を壊す。失敗したときに元が消えないのも同じ理由
     */
    const working = `${output}.encoding`;

    // スクランブルが掛かったまま録れていたら、ここで解く (scramble.ts)
    /** 後始末で消す作業ファイル。生TSを置き換えたときは残す側になるので null のまま */
    let decoded: string | null = null;
    let sourceTs = input;
    if (isScrambled(input)) {
        setPhase(jobId, 'descramble', 'スクランブルを解いています');
        const target = `${input}.decoded.ts`;
        const result = await descramble(input, target, signal);
        if (!result.ok) {
            removeIfExists(target);
            // 中止で切ったときは失敗にしない。下の後始末で canceled として畳む
            if (canceled.has(jobId)) return finishCanceled(jobId, target);
            fail(jobId, recording, `スクランブルを解除できませんでした: ${result.error}`);
            return;
        }
        if (keepOriginal()) {
            // 生TSを残す設定なら、残すのは解けたほうだけにする。
            // 掛かったままのTSを取っておいても、あとから解ける保証は無い
            renameSync(target, input);
        } else {
            decoded = target;
            sourceTs = target;
        }
    }

    const encodeOptions: EncodeOptions & { chaptersFile: string | null } = {
        ...(await prepareCm(jobId, recording, sourceTs, signal)),
        // コマ数は番組のジャンルで決まる。国内アニメだけ倍にしない (deinterlace)
        smoothMotion: smoothMotionFor(recording.genre_detail),
    };
    if (canceled.has(jobId)) return finishCanceled(jobId, decoded);

    // CMを実際に切る場合は、エンコードの前にTSの段階で切っておく。
    // エンコードのフィルタで切ると字幕のタイミングを追従させられず落とすことになる
    let source = sourceTs;
    let trimmed: string | null = null;
    const keep = encodeOptions.keep ?? null;
    if (keep !== null && keep.length > 0) {
        trimmed = await trimCm(jobId, sourceTs, keep, signal);
        if (trimmed !== null) source = trimmed;
    }
    if (canceled.has(jobId)) {
        removeIfExists(trimmed);
        removeIfExists(encodeOptions.chaptersFile);
        return finishCanceled(jobId, decoded);
    }

    setPhase(jobId, 'encode', '');

    /*
     * 尺と fps を先に測っておく。ffmpeg の stderr に出る Duration を当てにしていた頃は、
     * 拾えない TS だと割合が最後まで 0% のままだった
     */
    const measured = await probeVideo(source);
    // 字幕を絵で焼くときの画面の大きさ。渡さないと 1440x1080 とみなされ、
    // 1920x1080 の録画では字幕だけ横に伸びる
    if (Number.isFinite(measured.width) && Number.isFinite(measured.height)) {
        encodeOptions.canvasSize = `${measured.width}x${measured.height}`;
    }
    // 映像が始まるまでの間。全部のトラックをこのぶん前へ寄せて 0 秒から始める
    encodeOptions.videoStart = measured.videoStart;

    /*
     * 画素が横長なら、正方形に直した大きさで焼く (地上波HDは 1440x1080 の SAR 4:3)。
     * **もともと正方形なら渡さない** — 同じ大きさへの scale は仕事が増えるだけ
     */
    if (Number.isFinite(measured.width) && Number.isFinite(measured.height) && measured.sar !== 1) {
        const width = Math.round((measured.width * measured.sar) / 2) * 2;
        if (width > 0 && width !== measured.width) {
            encodeOptions.displaySize = { width, height: measured.height };
        }
    }

    /*
     * 放送どおりに描いた字幕を PGS にしておく。
     *
     * ffmpeg には PGS の符号器が無いので denpa が書く。焼くほうを dvdsub だけに
     * していた頃は1枚4色までで、実測230色の字幕から縁のなめらかさと色分けが落ちていた。
     * 作れなければ黙って諦める (字幕トラックが1本減るだけ)
     */
    setPhase(jobId, 'encode', '字幕を絵にしています');
    const pgs = await buildPgs(source, encodeOptions.canvasSize, SUBTITLE_FONTS, signal);
    if (pgs !== null) {
        encodeOptions.pgsFile = pgs.path;
        database()
            .prepare('UPDATE encode_jobs SET log = ? WHERE id = ?')
            .run(`字幕 ${pgs.captions} 枚を PGS にしました`, jobId);
    }
    if (canceled.has(jobId)) {
        removeIfExists(pgs?.path ?? null);
        removeIfExists(trimmed);
        removeIfExists(encodeOptions.chaptersFile);
        return finishCanceled(jobId, decoded);
    }

    /*
     * **焼き方は焼くときの設定に従う。**
     *
     * 録画の行にもコーデックとCMの扱いが写してあるが、それは**録り始めた時点**の
     * 値で、設定を変えても直らない。同じ設定が2箇所にあると、どちらで決まったのか
     * 分からなくなる (生TSを残すかどうかは前から設定を見ていて、ここだけ
     * 食い違っていた)。予約にもルールにも持たせない、が揃った形
     */
    let result = await runFfmpeg(
        job,
        source,
        working,
        recording.audio_type,
        null,
        settings().codec,
        encodeOptions,
        measured,
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
            settings().codec,
            encodeOptions,
            measured,
        );
    }

    removeIfExists(encodeOptions.chaptersFile);
    removeIfExists(encodeOptions.pgsFile ?? null);
    // CMを切ったTSも解除したTSも作業用。元のTSは残したままなので、やり直せる
    removeIfExists(trimmed);
    removeIfExists(decoded);

    // 出来かけを捨てるだけ。元のファイルには触らない
    if (canceled.has(jobId)) return finishCanceled(jobId, working);

    if (result.code !== 0) {
        removeIfExists(working);
        fail(jobId, recording, result.stderrTail);
        return;
    }

    // ここで初めて本来の場所に置く。同じ名前なら上書きになる
    renameSync(working, output);
    /*
     * 番組名が変わっていると置き場所も変わる。前のエンコード済みが別名で残ると
     * 同じ録画が2本並ぶので、サイドカーごと片付ける
     */
    if (recording.library_path !== null && recording.library_path !== output) {
        removeIfExists(recording.library_path);
        const stale = sidecarPaths(recording.library_path);
        removeIfExists(stale.nfo);
        removeIfExists(stale.thumbnail);
    }

    let size = 0;
    try {
        size = statSync(output).size;
    } catch {
        // 取れなくても致命的ではない
    }

    /*
     * 出来上がりの長さで上書きする。CMを切っていれば元のTSより短い。
     *
     * **出来上がったものを測る。** ffmpeg が言ってきた `out_time` を書いていた頃は、
     * 壊れた副音声が1本混ざっている録画で **8.576 秒**と入っていた
     * (中身は 30分ぶん正しく入っていた)。理由は進み具合が止まるのと同じ
     * (`parseProgressBlock`)。測れなかったときだけ、これまでどおり ffmpeg の値に落ちる
     */
    const made = (await probeVideo(output)).duration;
    const length = Number.isFinite(made) ? made * 1000 : result.outTimeUs / 1000;
    if (Number.isFinite(length) && length > 0) {
        database()
            .prepare('UPDATE recordings SET duration_ms = ? WHERE id = ?')
            .run(Math.round(length), recording.id);
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

    // 保存先が入った時点で「視聴可能」になる (recordings.state は生成列)
    if (keepOriginal()) {
        database()
            .prepare(`UPDATE recordings SET library_path = ?, ts_size = ?, updated_at = ? WHERE id = ?`)
            .run(output, size, now(), recording.id);
    } else {
        removeIfExists(recording.ts_path);
        database()
            .prepare(
                `UPDATE recordings SET library_path = ?, ts_path = NULL, ts_size = ?, updated_at = ? WHERE id = ?`,
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
        // 待機中が走り出したことも伝える。押した直後に何も変わらないと止まって見える
        emit('recordings');
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
                aborts.delete(jobId);
                canceled.delete(jobId);
                emit('recordings');
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
            `UPDATE encode_jobs SET state = 'queued', phase = 'encode', percent = 0, eta_ms = NULL,
                    started_at = NULL WHERE state = 'running'`,
        )
        .run().changes;
}
