/**
 * 設定は全て環境変数から読む。テスト(E2E)では偽の Mirakurun / Jellyfin / ffmpeg を
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

    /**
     * 録画の削除は Jellyfin の UI から直接行うので、連携は任意。
     * 設定しておくと、新しい録画を置いたときに Jellyfin へ再スキャンを促せる。
     */
    jellyfinUrl: str('JELLYFIN_URL', '').replace(/\/+$/, ''),
    jellyfinApiKey: str('JELLYFIN_API_KEY', ''),

    dbPath: str('DENPA_DB', '/app/data/denpa.db'),
    /** 生TSの置き場。エンコード後は(keep_original でなければ)消える作業領域 */
    recordedDir: str('RECORDED_DIR', '/app/recorded'),
    /** Jellyfin が読むライブラリ。エンコード済みだけがここに入る */
    libraryDir: str('LIBRARY_DIR', '/library'),

    ffmpeg: str('FFMPEG', '/usr/local/bin/ffmpeg'),
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
     * M3U に書き込む denpa 自身のURL。Jellyfin から解決できる形にする
     * (同じクラスタなら `http://denpa:3000`)。空ならリクエストのオリジンを使う
     */
    iptvOrigin: str('IPTV_ORIGIN', '').replace(/\/+$/, ''),
    /** Jellyfin に渡す既定のプロファイル。h264 / av1 */
    liveProfile: str('LIVE_PROFILE', 'h264'),
    /** H.264 側の x264 プリセット。実時間に間に合わないときは速い側へ */
    livePreset: str('LIVE_PRESET', 'veryfast'),
    /**
     * AV1 側の SVT-AV1 プリセット(0〜13、大きいほど速い)。
     * 録画のバッチエンコードと違い実時間で回す必要があるので、既定はかなり速い側に振ってある。
     * それでもソフトウェアエンコードでHDを実時間で回すのは厳しい(README参照)。
     */
    liveAv1Preset: num('LIVE_AV1_PRESET', 10),
    liveCrf: num('LIVE_CRF', 23),
    /** 誰も読まなくなったストリームを切ってチューナーを解放するまでの時間(ms) */
    liveIdleTimeout: num('LIVE_IDLE_TIMEOUT', 30 * SEC),

    /**
     * Jellyfin に作るライブラリの名前。
     * ライブTVのタイルと並ぶので、中身が分かる名前にしておく
     */
    jellyfinLibraryName: str('JELLYFIN_LIBRARY_NAME', '録画'),
    /** Jellyfin 向けの .nfo を書くか */
    writeNfo: bool('WRITE_NFO', true),
    /** サムネイルを切り出す位置(秒)。頭は提供表示やCMのことが多いので少し進める */
    thumbnailPosition: num('THUMBNAIL_POSITION', 120),
    thumbnailWidth: num('THUMBNAIL_WIDTH', 480),

    /** 録画の前後マージン(ms)。放送時刻のズレを吸収する */
    startMargin: num('START_MARGIN', 10 * SEC),
    endMargin: num('END_MARGIN', 15 * SEC),

    epgSyncInterval: num('EPG_SYNC_INTERVAL', 10 * MIN),
    schedulerTick: num('SCHEDULER_TICK', 5 * SEC),
    /** ライブラリの実体とDBを突き合わせる間隔。Jellyfin 側での削除をここで拾う */
    reconcileInterval: num('RECONCILE_INTERVAL', 5 * MIN),
    /** Jellyfin の録画タイマーを取り込む間隔。押してから反映されるまでの待ち時間になる */
    timerImportInterval: num('JELLYFIN_TIMER_INTERVAL', 30 * SEC),
    /** 終了した番組情報をDBに残しておく期間。番組表の遡り表示にしか使わないので短くてよい */
    programRetention: num('PROGRAM_RETENTION', 24 * 60 * MIN),

    /** 0 にすると EPG 取得・スケジューラ・エンコーダを起動しない (単体テスト用) */
    autostart: bool('DENPA_AUTOSTART', true),
};

export type Config = typeof config;
