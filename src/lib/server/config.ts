/**
 * 動かすときに決めるもの。
 *
 * **環境変数にするのは、外から差し替える理由があるものだけ。**
 * 相手の居場所 (mirakc・ffmpeg・置き場) と、間隔やマージンのように
 * テストで詰めたいもの。それ以外はここに直に書く。
 *
 * 昔は検出のしきい値もサムネイルの大きさも環境変数にしていたが、
 * 誰も触らないのに「触れる」ぶん、既定値がどこで決まっているのか
 * 追いにくくなるだけだった。**画面から変えたいものは設定画面** (settings.ts)。
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
    mirakcUrl: str('MIRAKC_URL', 'http://mirakc:40772').replace(/\/+$/, ''),
    /**
     * スクランブル解除の受け口。mirakc と同じコンテナに居る。
     * B-CASカードは pcscd 経由でしか読めず、その pcscd は向こう側にしか無いので、
     * 掛かったまま録れたTSは投げて解いてもらう
     */
    tunerAgentUrl: str('TUNER_AGENT_URL', 'http://mirakc:40773').replace(/\/+$/, ''),

    dbPath: str('DENPA_DB', '/app/data/denpa.db'),
    /** DBと並べて置くもの。局ロゴと、jls が作るロゴデータ */
    dataDir: '',
    /** 生TSの置き場。エンコード後は(keep_original でなければ)消える作業領域 */
    recordedDir: str('RECORDED_DIR', '/app/recorded'),
    /** エンコード済みの置き場。プレイヤーにはここのファイルを配る */
    libraryDir: str('LIBRARY_DIR', '/library'),

    ffmpeg: str('FFMPEG', '/usr/local/bin/ffmpeg'),
    encodeConcurrency: num('ENCODE_CONCURRENCY', 1),
    /** 先頭が壊れていて初期化に失敗したときに頭を捨てて再試行する秒数 (enc.js 由来) */
    encodeRetrySeek: 0.2,
    ffprobe: str('FFPROBE', '/usr/local/bin/ffprobe'),

    /** 録画エンコードの初期コーデック。設定画面で変えられる */
    encodeCodec: 'av1' as VideoCodec,
    /** CMの扱いの初期値。実カットは事故ると本編が消えるのでチャプターのみ */
    cmCutDefault: 'chapter' as CmMode,

    /** chapter_exe / logoframe / join_logo_scp の置き場。イメージに入っている */
    jlsBin: '/opt/jls/bin',
    /** join_logo_scp の判定規則。join_logo_scp_trial に付いてくるもの */
    jlsRule: '/opt/jls/JL/JL_標準.txt',
    /** logoframe が作るロゴデータ (.lgd) の置き場。データ置き場の下 */
    jlsLogoDir: '',
    /** ロゴを覚えるときに見るコマ数。増やすほど綺麗に出るが、その分だけ読む */
    jlsLogoSamples: 600,
    /** jls が返す Trim はフレーム番号なので、秒に直すためのfps。ffprobeで取れなければこれを使う */
    cmJlsFallbackFps: 30000 / 1001,
    /** 検出に掛ける上限時間(ms)。超えたら諦めてCM無しとして扱う */
    cmDetectTimeout: 30 * MIN,
    /** 無音とみなす音量。地上波のCM境界は -50dB 程度まで落ちる */
    cmSilenceNoise: '-50dB',
    /** 無音とみなす最短の長さ(秒)。短くしすぎると曲間や間(ま)を拾う */
    cmSilenceDuration: 0.4,
    /** 「15秒の倍数」判定の許容誤差(秒) */
    cmTolerance: 0.6,
    /** CMブロックとして採用する最短の長さ(秒)。単発15秒は本編のコーナーと紛らわしい */
    cmMinBlock: 30,

    /** 番組情報の .nfo。Kodi など .nfo を読むプレイヤー向け */
    writeNfo: true,
    /** サムネイルを切り出す位置(秒)。頭は提供表示やCMのことが多いので少し進める */
    thumbnailPosition: 120,
    thumbnailWidth: 480,

    /** 録画の前後マージン(ms)。放送時刻のズレを吸収する */
    startMargin: num('START_MARGIN', 10 * SEC),
    endMargin: num('END_MARGIN', 15 * SEC),

    /**
     * 放送の延長に追従する。
     *
     * 番組単位のストリーム (`/api/programs/:id/stream`) で録ると、切れ目を決めるのが
     * 番組表の時刻ではなく**いま流れている放送** (EIT[p/f]) になる。野球が延びれば
     * その分だけ録り続け、頭に前番組が混ざることもなくなる。
     *
     * 0 にすると番組表の時刻で開いて閉じる、前のやり方に戻る。
     */
    followOnair: true,
    /**
     * 延長を見に行く間隔。
     * 普段は mirakc からの知らせ (`/events` の `onair.program-changed`) で拾うので、
     * これは**知らせが途切れたときの保険**。短くしても得は無い
     */
    onairPollInterval: num('ONAIR_POLL_INTERVAL', 5 * MIN),
    /**
     * 番組単位で開いたのに何も流れてこないとき、サービス単位に切り替えるまでの待ち時間。
     * mirakc は番組が始まるまで1バイトも出さないので、開いた直後は空でも正常
     */
    onairFallbackWait: num('ONAIR_FALLBACK_WAIT', 90 * SEC),

    /**
     * 番組表を取り直す間隔。
     * 普段は mirakc からの知らせ (`/events` の `epg.programs-updated`) で取り直すので、
     * これも保険。知らせが黙って止まっても、ここで必ず追い付く
     */
    epgSyncInterval: num('EPG_SYNC_INTERVAL', 10 * MIN),
    /**
     * 局だけを取り直す間隔。
     *
     * mirakc は局と番組表を別々に持っていて、**局が揃ったことは知らせてくれない**
     * (飛んでくるのは `epg.programs-updated` だけ)。初回起動やスキャン直後は
     * 「局は分かったが番組表はこれから」が数十分続くので、局だけ先に拾いに行く
     */
    serviceSyncInterval: num('SERVICE_SYNC_INTERVAL', 1 * MIN),
    /**
     * 知らせが来てから取り直すまでの間。
     * 番組表が更新されると局の数だけ知らせが飛んでくる (実機で30件ほど連続) ので、
     * 静まるのを待ってから1回だけ取り直す
     */
    epgEventDebounce: num('EPG_EVENT_DEBOUNCE', 10 * SEC),
    /**
     * 止められたとき、録画が終わるまで待つ上限。
     *
     * 0 で待たずに止まる。**Kubernetes の terminationGracePeriodSeconds と
     * docker compose の stop_grace_period をこれ以上にしておくこと** (runtime.ts)
     */
    shutdownWait: num('SHUTDOWN_WAIT', 6 * 60 * MIN),
    schedulerTick: num('SCHEDULER_TICK', 5 * SEC),
    /** 保存先の実体とDBを突き合わせる間隔。外から消されたものをここで拾う */
    reconcileInterval: num('RECONCILE_INTERVAL', 5 * MIN),
    /**
     * 局ロゴを取りに行く間隔。放送波に流れてくるのを待つので、急いでも取れない。
     * ただし1回に開けるのは数チャンネルなので、間隔が長いと BS/CS が埋まらない
     */
    logoSweepInterval: 10 * MIN,
    /** 終了した番組情報をDBに残しておく期間。番組表の遡り表示にしか使わないので短くてよい */
    programRetention: 24 * 60 * MIN,
    /**
     * 履歴を残しておく期間。終わった予約と、消した録画の行が対象。
     *
     * 「録れたか」を後から確かめるためのものなので、2週間もあれば足りる。
     * 残し続けると一覧が伸びるだけで、探すのがかえって遅くなる。
     */
    historyRetention: 14 * 24 * 60 * MIN,

    /**
     * ベーシック認証。ユーザー名とパスワードの両方が入っているときだけ有効になる。
     *
     * 画面の前段に別の認証(forward-auth など)を置いている場合、プレイヤーや Kodi は
     * そのリダイレクトを扱えない。そこで「ファイルを取りに来る口だけ」に
     * ベーシック認証をかけられるようにしてある。
     */
    basicAuthUser: str('BASIC_AUTH_USER', 'denpa'),
    basicAuthPassword: str('BASIC_AUTH_PASSWORD', ''),
    /**
     * 認証をかける範囲の初期値。設定画面で変えられる。
     * `files` … 録画の配信と WebDAV だけ。画面は素通し
     * `all`   … 画面も含めて全部
     *
     * **ここも環境変数から読む。** 読んでいなかった頃は `BASIC_AUTH_SCOPE=all` を
     * 渡しても黙って `files` のままで、画面に認証が掛かっているつもりでいられた
     * (文書には「初期値として使える」と書いてあった)。
     */
    basicAuthScope: (str('BASIC_AUTH_SCOPE', 'files') === 'all' ? 'all' : 'files') as 'files' | 'all',

    /** 0 にすると EPG 取得・スケジューラ・エンコーダを起動しない (単体テスト用) */
    autostart: bool('DENPA_AUTOSTART', true),
};

/** 指定が無ければDBの隣。運用でいちいち2つ指す意味が無い */
if (config.dataDir === '') config.dataDir = config.dbPath.replace(/\/[^/]*$/, '') || '.';
/** 局ロゴと同じ扱い。放送波から拾った PNG の隣に、jls 用の .lgd を置く */
if (config.jlsLogoDir === '') config.jlsLogoDir = `${config.dataDir}/logos/jls`;

export type Config = typeof config;
