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
    /**
     * チューナーエージェントの居場所。
     *
     * 選局もスクランブル解除もチャンネルスキャンも、全部ここが窓口。
     * B-CASカードは pcscd 経由でしか読めず、その pcscd は向こう側にしか無い。
     * 別PCのチューナーを足すときは、そのPCのエージェントを指す
     */
    agentUrl: str('TUNER_AGENT_URL', 'http://tuner-agent:25252').replace(/\/+$/, ''),

    /**
     * チューナーの取り合いの強さ。**大きいほうが勝つ。**
     *
     * mirakc の `X-Mirakurun-Priority` は負値が 0 に丸められ、−1 は
     * mirakc 自身の番組表集めに取られていたので、番号の付け方が向こうの都合に
     * 縛られていた。エージェントに移ってからは**こちらが全部決める**。
     *
     * 録画がいちばん強い。放送は二度と来ないので、ここだけは譲らせない。
     */
    priority: {
        recording: 10,
        /** 人が押して待っている。番組表には譲らせるが、録画は蹴らない (agent/scan.ts と揃える) */
        scan: 5,
        epg: 3,
        logo: 1,
    },

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

    /**
     * CM検出のロゴを覚えに行く間隔。**録画より先に覚えておくため** (logo-learn.ts)。
     *
     * 覚えるのは局ごとに1回きりなので、頻繁に見回る意味はない。空いている
     * チューナーがあるときだけ動く
     */
    logoLearnInterval: 30 * MIN,

    /** chapter_exe / logoframe / join_logo_scp の置き場。イメージに入っている */
    jlsBin: '/opt/jls/bin',
    /** join_logo_scp の判定規則。join_logo_scp_trial に付いてくるもの */
    jlsRule: '/opt/jls/JL/JL_標準.txt',
    /** logoframe が作るロゴデータ (.lgd) の置き場。データ置き場の下 */
    jlsLogoDir: '',
    /** ロゴを覚えるときに見るコマ数。増やすほど綺麗に出るが、その分だけ読む */
    jlsLogoSamples: 600,
    /**
     * 「ずっと同じ縁がある」と認める強さ。**logoframe の既定のまま。**
     *
     * 一度 60 まで上げたが、**実機の TOKYO MX が覚えられなくなった**。上げると
     * 探し当てる場所は正しくなる (`1244,62,136,44` = ロゴのある所) のに、
     * そこから作る推定が「有効な画素が少なすぎる」と弾かれる。MX のロゴは
     * 細い白文字なので、強い縁を要求すると画素が残らない。
     *
     * 既定 (40) で覚えたものを実際に見ると「TOKYO MX 1」がちゃんと写っていて、
     * 最後まで通すとCM判定も 20% と妥当だった。締める理由が無い
     */
    jlsLogoEdgeThreshold: 40,
    /**
     * 覚えているロゴの合致率がこれ(%)を下回ったら覚え直す。**既定のまま。**
     *
     * 「雑音を覚えたまま作り直されない」を心配して 50 にしていたが、実機で
     * 中身を出してみると雑音ではなかった (こちらが `.lgd` の幅と高さを逆に
     * 読んでいて、絵が転置されていただけ)。上げると、ロゴが出ない場面の多い
     * 番組で無用な作り直しを招く
     */
    jlsLogoMatch: 10,
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
     * 録画中のTSには EIT[p/f] (いま流れている番組) が乗っている。そこの終了時刻が
     * 後ろへ動いたら録画も延ばす。野球が延びればその分だけ録り続ける。
     *
     * 0 にすると番組表の時刻で開いて閉じる、前のやり方に戻る。
     */
    followOnair: true,

    /**
     * 番組表を集めに行く間隔。**この周期で「集め直すべき局」を選び直す。**
     *
     * mirakc は 8:21 と 20:21 の1日2回で、1本のチューナーが1チャンネルずつ
     * 回っていた (実測で1周1時間以上)。こちらはチューナーが空いていれば
     * 空いているだけ並列に回すので、周期を短くしても取り合いにはならない
     */
    epgCollectInterval: num('EPG_COLLECT_INTERVAL', 30 * MIN),
    /** 同じチャンネルを集め直すまでの間。番組表は当日ぶんが直前まで書き換わる */
    epgChannelInterval: num('EPG_CHANNEL_INTERVAL', 6 * 60 * MIN),
    /**
     * 1チャンネルを開いておく上限。
     *
     * EIT は「自分がどこまであるか」をセクションの中で言っているので、普通は
     * 揃った時点で閉じる (`ts/eit.ts` の ScheduleProgress)。ここまで待つのは
     * 電波が弱くて欠けが埋まらないときだけ
     */
    epgChannelTimeout: num('EPG_CHANNEL_TIMEOUT', 5 * MIN),
    /**
     * 番組表がこの先まで埋まっていない局は、周期を待たずに集め直す。
     *
     * スキャンの直後や初回起動では全部が空なので、ここで先に埋まる
     */
    epgMinCoverage: num('EPG_MIN_COVERAGE', 3 * 24 * 60 * MIN),
    /** 局の一覧をエージェントから取り直す間隔。スキャンの結果はここで届く */
    channelSyncInterval: num('CHANNEL_SYNC_INTERVAL', 1 * MIN),
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
