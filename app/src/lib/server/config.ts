/**
 * 設定は全て環境変数から読む。テスト(E2E)では偽の Mirakurun / ffmpeg を
 * 指すよう差し替えて同じコードパスを通せるようにするため、パスや間隔も含めて
 * ハードコードせず全部ここに集約する。
 */

import type { CmMode, VideoCodec } from '../types';

function str(key: string, fallback: string): string {
    const v = process.env[key];
    return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
    const v = process.env[key];
    if (v === undefined || v === '') return fallback;
    return v === '1' || v.toLowerCase() === 'true';
}

const SEC = 1000;
const MIN = 60 * SEC;

export const config = {
    mirakurunUrl: str('MIRAKURUN_URL', 'http://mirakurun:40772').replace(/\/+$/, ''),

    dbPath: str('DENPA_DB', '/app/data/denpa.db'),
    /** 生TSの置き場。エンコード後は(keep_original でなければ)消える作業領域 */
    recordedDir: str('RECORDED_DIR', '/app/recorded'),
    /** エンコード済みの置き場。プレイヤーにはここのファイルを配る */
    libraryDir: str('LIBRARY_DIR', '/library'),

    ffmpeg: str('FFMPEG', '/usr/local/bin/ffmpeg'),
    // スクランブルが掛かったまま録れてしまったTSを、エンコードの前に解くのに使う
    recisdb: str('RECISDB', '/usr/bin/recisdb'),
    encodeConcurrency: num('ENCODE_CONCURRENCY', 1),
    /** 先頭が壊れていて初期化に失敗したときに頭を捨てて再試行する秒数 (enc.js 由来) */
    encodeRetrySeek: num('ENCODE_RETRY_SEEK', 0.2),
    /** 録画エンコードの既定コーデック。非力なマシンでは h264 にする */
    encodeCodec: str('ENCODE_CODEC', 'av1') as VideoCodec,
    /** h264 のときの x264 設定。ライブと違い実時間の縛りが無いので品質寄り */
    encodeH264Preset: str('ENCODE_H264_PRESET', 'medium'),
    encodeH264Crf: num('ENCODE_H264_CRF', 22),

    /** CMの扱いの既定値。実カットは事故ると本編が消えるので既定はチャプターのみ */
    cmCutDefault: str('CM_CUT_DEFAULT', 'chapter') as CmMode,
    /**
     * CM検出の実装。
     * silence: 無音 + CM尺(15秒の倍数)。追加のツールもロゴデータも要らない既定値。
     * jls    : join_logo_scp (Amatsukaze と同じ検出核) にロゴ検出まで任せる。精度は高いが
     *          イメージに chapter_exe / logoframe / join_logo_scp と局ごとのロゴデータが要る。
     */
    cmDetector: str('CM_DETECTOR', 'silence') as 'silence' | 'jls',
    /** jls 検出器の起動コマンド。`{input}` が録画ファイルのパスに置換される */
    cmJlsCommand: str('CM_JLS_COMMAND', '/opt/jls/JoinLogoScpTrial.sh {input}'),
    /** jls の出力(Trim入りのavs)の探索先。空ならコマンドの標準出力から拾う */
    cmJlsOutputDir: str('CM_JLS_OUTPUT_DIR', ''),
    /** jls が返す Trim はフレーム番号なので、秒に直すためのfps。ffprobeで取れなければこれを使う */
    cmJlsFallbackFps: num('CM_JLS_FALLBACK_FPS', 30000 / 1001),
    /** 検出に掛ける上限時間(ms)。超えたら諦めてCM無しとして扱う */
    cmDetectTimeout: num('CM_DETECT_TIMEOUT', 30 * MIN),
    ffprobe: str('FFPROBE', '/usr/local/bin/ffprobe'),
    /** 無音とみなす音量。地上波のCM境界は -50dB 程度まで落ちる */
    cmSilenceNoise: str('CM_SILENCE_NOISE', '-50dB'),
    /** 無音とみなす最短の長さ(秒)。短くしすぎると曲間や間(ま)を拾う */
    cmSilenceDuration: num('CM_SILENCE_DURATION', 0.4),
    /** 「15秒の倍数」判定の許容誤差(秒) */
    cmTolerance: num('CM_TOLERANCE', 0.6),
    /** CMブロックとして採用する最短の長さ(秒)。単発15秒は本編のコーナーと紛らわしい */
    cmMinBlock: num('CM_MIN_BLOCK', 30),

    /**
     * 番組情報の .nfo を書くか。
     * denpa の画面には要らないが、Kodi など .nfo を読むプレイヤー向けに残してある
     */
    writeNfo: bool('WRITE_NFO', true),
    /** サムネイルを切り出す位置(秒)。頭は提供表示やCMのことが多いので少し進める */
    thumbnailPosition: num('THUMBNAIL_POSITION', 120),
    thumbnailWidth: num('THUMBNAIL_WIDTH', 480),

    /** 録画の前後マージン(ms)。放送時刻のズレを吸収する */
    startMargin: num('START_MARGIN', 10 * SEC),
    endMargin: num('END_MARGIN', 15 * SEC),

    epgSyncInterval: num('EPG_SYNC_INTERVAL', 10 * MIN),
    schedulerTick: num('SCHEDULER_TICK', 5 * SEC),
    /** 保存先の実体とDBを突き合わせる間隔。外から消されたものをここで拾う */
    reconcileInterval: num('RECONCILE_INTERVAL', 5 * MIN),
    /** 終了した番組情報をDBに残しておく期間。番組表の遡り表示にしか使わないので短くてよい */
    programRetention: num('PROGRAM_RETENTION', 24 * 60 * MIN),

    /**
     * ベーシック認証。ユーザー名とパスワードの両方が入っているときだけ有効になる。
     *
     * 画面の前段に別の認証(forward-auth など)を置いている場合、プレイヤーや Kodi は
     * そのリダイレクトを扱えない。そこで「ファイルを取りに来る口だけ」に
     * ベーシック認証をかけられるようにしてある。
     */
    basicAuthUser: str('BASIC_AUTH_USER', ''),
    basicAuthPassword: str('BASIC_AUTH_PASSWORD', ''),
    /**
     * 認証をかける範囲。
     * `files` … 録画の配信と WebDAV だけ (既定)。画面は素通し
     * `all`   … 画面も含めて全部
     */
    basicAuthScope: str('BASIC_AUTH_SCOPE', 'files') as 'files' | 'all',

    /** 0 にすると EPG 取得・スケジューラ・エンコーダを起動しない (単体テスト用) */
    autostart: bool('DENPA_AUTOSTART', true),
};

export type Config = typeof config;
