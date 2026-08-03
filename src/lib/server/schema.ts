/** スキーマは TS の文字列として持つ。?raw インポートに頼らないので、
 * vite のビルド経由でも bun test の直接実行でも同じように読める。
 */
/**
 * 後から足した列。
 *
 * `CREATE TABLE IF NOT EXISTS` は既存のテーブルに列を足さないので、
 * スキーマに書くだけでは動いているDBには反映されない(実際に本番が500を返した)。
 * 列を足すときは SCHEMA と一緒にここへも書くこと。
 */
export const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
    { table: 'services', column: 'has_logo', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'rules', column: 'cm_cut', definition: "TEXT NOT NULL DEFAULT 'chapter'" },
    { table: 'rules', column: 'codec', definition: "TEXT NOT NULL DEFAULT 'av1'" },
    { table: 'rules', column: 'service_types', definition: 'TEXT' },
    { table: 'reservations', column: 'cm_cut', definition: "TEXT NOT NULL DEFAULT 'chapter'" },
    { table: 'reservations', column: 'codec', definition: "TEXT NOT NULL DEFAULT 'av1'" },
    { table: 'recordings', column: 'cm_cut', definition: "TEXT NOT NULL DEFAULT 'chapter'" },
    { table: 'recordings', column: 'codec', definition: "TEXT NOT NULL DEFAULT 'av1'" },
    { table: 'recordings', column: 'cm_ranges', definition: 'TEXT' },
    { table: 'recordings', column: 'acknowledged_at', definition: 'INTEGER' },
    // 実際に録れた長さ。番組表の尺とは途中で止めた分だけずれる
    { table: 'recordings', column: 'duration_ms', definition: 'INTEGER' },
    // 番組詳細に出すためだけの情報。録画の判断には使わない
    { table: 'programs', column: 'video_type', definition: 'TEXT' },
    { table: 'programs', column: 'video_resolution', definition: 'TEXT' },
    { table: 'programs', column: 'audios', definition: 'TEXT' },
    { table: 'programs', column: 'genre_detail', definition: 'TEXT' },
    // 引き継ぎ元での識別子。二重に取り込まないための印
    { table: 'rules', column: 'source', definition: 'TEXT' },
    /*
     * キーワードを当てる範囲 (name / description / extended のカンマ区切り)。
     *
     * 既定値がスキーマ側 ('name') と違うのはわざと。この列が無かった頃のルールは
     * 「番組名+概要」で当てていたので、そのまま埋めないと黙って当たらなくなる。
     * 新しく作るルールの初期値は番組名だけ (画面側)
     */
    { table: 'rules', column: 'search_fields', definition: "TEXT NOT NULL DEFAULT 'name,description'" },
    // ARIB のサービス種別。1 がデジタルTV
    { table: 'services', column: 'service_type', definition: 'INTEGER NOT NULL DEFAULT 1' },
    /*
     * エンコードのどの段階か。'encode' 以外は ffmpeg が回る前の下ごしらえで、
     * 長いものだと数十分かかる。進み具合が出せないので、代わりに段階を出す
     */
    { table: 'encode_jobs', column: 'phase', definition: "TEXT NOT NULL DEFAULT 'encode'" },
    // 残り時間の見込み(ms)。ffmpeg の speed から出す
    { table: 'encode_jobs', column: 'eta_ms', definition: 'INTEGER' },
    /*
     * 局ロゴの位置 ("x,y,w,h")。CM検出を jls にしているときだけ使う。
     * 空なら logoframe が自分で探す。探せなかった局だけ画面から入れてもらう
     */
    { table: 'services', column: 'logo_area', definition: 'TEXT' },
    // CM検出が何をしたか。一覧には出さず、録画の詳細で見せる
    { table: 'recordings', column: 'cm_note', definition: 'TEXT' },
    // ロゴを当てられなかった。位置を教えてもらうために印を付ける
    { table: 'recordings', column: 'logo_missing', definition: 'INTEGER NOT NULL DEFAULT 0' },
    /*
     * 番組のジャンル (JSON: lv1 の配列)。番組表から写しておく。
     *
     * エンコードのコマ数をこれで決める (encoder.ts の deinterlace)。番組表の行は
     * 24時間で消えるので、録り直しのたびに引き直せるようにしておく必要がある
     */
    { table: 'recordings', column: 'genre_detail', definition: 'TEXT' },
    /*
     * 録り終えた時刻 / 録り始めた時刻。
     *
     * どちらも「状態の文字列を持つのをやめる」ために足したもの。
     * 中身の入れ直しは列を足すだけでは済まないので {@link dropStoredState} が続きをやる
     */
    { table: 'recordings', column: 'finished_at', definition: 'INTEGER' },
    { table: 'reservations', column: 'started_at', definition: 'INTEGER' },
];

/**
 * 録画の状態。**列としては持たず、事実から毎回決める。**
 *
 * CREATE TABLE の生成列と、既にあるDBを移し替えるとき (db.dropStoredState) の
 * 両方から使う。二か所に書くと必ず食い違うので、式はここにしか置かない。
 */
export const RECORDING_STATE = `
        CASE
            WHEN deleted_at IS NOT NULL THEN 'deleted'
            WHEN error IS NOT NULL THEN 'failed'
            WHEN finished_at IS NULL THEN 'recording'
            WHEN library_path IS NOT NULL THEN 'available'
            ELSE 'recorded'
        END`;

/**
 * 画面に出す予約の状態。**録り始めてからは録画の行が決める。**
 *
 * DBに入っているのは `scheduled | conflict | canceled | missed` だけ。
 * 予約 `r` と、その予約で録れた最新の録画 `rec` を LEFT JOIN した上で使う
 * (一覧と番組表の両方が要るので、式はここにしか置かない)。
 */
export const RESERVATION_STATE = `
        CASE
            WHEN r.started_at IS NULL THEN r.state
            WHEN rec.state = 'recording' THEN 'recording'
            WHEN rec.state = 'failed' THEN 'failed'
            ELSE 'done'
        END`;

export const SCHEMA = `
-- 全て CREATE ... IF NOT EXISTS で書き、起動のたびに流す。
-- 列を足すときは末尾に ALTER TABLE ... ADD COLUMN を追記していく方針
-- (単一ノード・単一プロセスの個人用途なのでマイグレーションツールは持たない)。

-- 画面から変えられる設定。環境変数を初期値として、ここにあれば上書きする。
-- いまは使っていないが、画面から変えたい設定が出たときのために残してある。
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 録画の節目を外部に飛ばす先。Discord や Slack の Incoming Webhook を想定している
CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 名前は廃止。1人で使うものに名札を付けても URL を見れば分かる。
    -- 既存の行を消さないので列だけ残してある
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    events TEXT NOT NULL,          -- JSON 配列。空配列は「全部」
    enabled INTEGER NOT NULL DEFAULT 1,
    last_status TEXT,              -- 直近の送信結果。設定画面で出す
    last_sent_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY,           -- mirakc の service id
    service_id INTEGER NOT NULL,
    network_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,               -- GR / BS / CS
    -- ARIB のサービス種別 (STD-B10)。1 = デジタルTV、2 = デジタル音声、
    -- 192 = データ/ワンセグ、164 = エンジニアリング。録るのは 1 だけ
    service_type INTEGER NOT NULL DEFAULT 1,
    channel TEXT NOT NULL,            -- 物理チャンネル。同一チャンネルの同時録画はチューナーを共有できる
    remote_control_key INTEGER,
    has_logo INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY,           -- mirakc の program id
    service_id INTEGER NOT NULL,
    network_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    extended TEXT,                    -- JSON
    genres TEXT,                      -- JSON: lv1 の配列。ルールの判定に使う
    genre_detail TEXT,                -- JSON: [{lv1, lv2}]。表示用
    is_free INTEGER NOT NULL DEFAULT 1,
    audio_type INTEGER,               -- ARIB の componentType。2 がデュアルモノ
    audios TEXT,                      -- JSON: [{componentType, langs}]。表示用
    video_type TEXT,                  -- mpeg2 / h.264 など
    video_resolution TEXT,            -- 1080i / 480i など
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS programs_time ON programs (start_at, end_at);
CREATE INDEX IF NOT EXISTS programs_service_time ON programs (service_id, start_at);

CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    keyword TEXT NOT NULL DEFAULT '',
    ignore_keyword TEXT NOT NULL DEFAULT '',
    -- キーワードを当てる範囲。name / description / extended のカンマ区切り
    search_fields TEXT NOT NULL DEFAULT 'name',
    service_ids TEXT,                 -- JSON 配列。NULL は全チャンネル対象
    service_types TEXT,               -- JSON 配列 (GR/BS/CS)。個別チャンネルとのORで効く
    genres TEXT,                      -- JSON 配列 (lv1)。NULL は全ジャンル
    free_only INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 2,
    encode INTEGER NOT NULL DEFAULT 1,
    keep_original INTEGER NOT NULL DEFAULT 0,
    -- off / chapter / cut。CMの扱い(cm.ts 参照)
    cm_cut TEXT NOT NULL DEFAULT 'chapter',
    -- av1 / h264。非力なマシンでは h264 のほうが実用的
    codec TEXT NOT NULL DEFAULT 'av1',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 1番組1予約。複数ルールが同じ番組にマッチしても二重録画にならないようにする
    program_id INTEGER NOT NULL UNIQUE,
    rule_id INTEGER,
    service_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    priority INTEGER NOT NULL DEFAULT 2,
    manual INTEGER NOT NULL DEFAULT 0,
    encode INTEGER NOT NULL DEFAULT 1,
    keep_original INTEGER NOT NULL DEFAULT 0,
    -- off / chapter / cut
    cm_cut TEXT NOT NULL DEFAULT 'chapter',
    codec TEXT NOT NULL DEFAULT 'av1',
    /*
     * scheduled | conflict | canceled | missed
     * missed = 始まらないまま放送が終わったもの(アプリが止まっていた等)。
     *
     * **録り始めてからの状態は持たない。** 録画の行がそれを知っているので、
     * ここに 'recording' / 'done' / 'failed' を書き写すと二重管理になる
     * (実際、録画が失敗しても予約側が 'recording' のまま残ることがあった)
     */
    state TEXT NOT NULL DEFAULT 'scheduled',
    -- 録り始めた時刻。NULL なら**まだ始めていない**。
    -- 二重に録り始めないための鍵でもある (scheduler.tick)
    started_at INTEGER,
    conflict_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_state_time ON reservations (state, start_at);

CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id INTEGER,
    program_id INTEGER,
    service_id INTEGER NOT NULL,
    service_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    series TEXT NOT NULL DEFAULT '',   -- 保存先でシリーズとしてまとめる単位
    subtitle TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    audio_type INTEGER,
    ts_path TEXT,
    ts_size INTEGER NOT NULL DEFAULT 0,
    library_path TEXT,
    -- 録り終えた時刻。NULL なら**まだチューナーを掴んでいる**。
    -- 「録画中かどうか」を文字列で持たないための、ただ一つの事実
    finished_at INTEGER,
    -- 録画そのものが失敗した理由。消したときは削除の理由も入る。
    -- **エンコードの失敗はここに書かない** (encode_jobs.error が持っている)
    error TEXT,
    keep_original INTEGER NOT NULL DEFAULT 0,
    -- off / chapter / cut
    cm_cut TEXT NOT NULL DEFAULT 'chapter',
    codec TEXT NOT NULL DEFAULT 'av1',
    cm_ranges TEXT,   -- 検出したCM区間の JSON。UIでの確認用
    -- JSON: [{lv1, lv2}]。エンコードのコマ数の判断に使う (国内アニメだけ30コマ)
    genre_detail TEXT,
    -- 実際に録れた長さ。番組表の尺 (end_at - start_at) は予定でしかなく、
    -- 途中で止めたときやCMを切ったときは実物と合わない
    duration_ms INTEGER,
    -- 消した時刻(denpa から、または外から)。行は履歴として残す
    deleted_at INTEGER,
    -- 失敗をユーザーが確認した時刻。以降ダッシュボードの通知に出さない
    acknowledged_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    /*
     * 状態は**持たない**。上の列から決まるものを毎回引き直す。
     *
     * 文字列で別に持っていた頃は、同じことを二重に書くことになっていた
     * (エンコードが始まれば 'encoding'、終われば library_path と一緒に 'available')。
     * 書き忘れれば食い違うし、実際にエンコードの失敗が録画そのものの失敗として
     * 'failed' に化けて、中身のある生TSを持ったまま再生もできなくなっていた。
     *
     * 生成列にしておくと SQLite が書き込みを拒むので、食い違いようがない。
     * 'encoding' はここに無い。動いているエンコードは encode_jobs にしか無く、
     * 一覧はそちらを見て「エンコード中」を出す (format.encodeLabel)
     */
    state TEXT GENERATED ALWAYS AS (${RECORDING_STATE}
    ) VIRTUAL
);
CREATE INDEX IF NOT EXISTS recordings_state ON recordings (state);
CREATE INDEX IF NOT EXISTS recordings_start ON recordings (start_at DESC);
-- 番組表は1マスごとに「この番組で録れたものはあるか」を引く。
-- 無いと24時間ぶんのマスの数だけ録画一覧を舐めることになる
CREATE INDEX IF NOT EXISTS recordings_program ON recordings (program_id);

CREATE TABLE IF NOT EXISTS encode_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id INTEGER NOT NULL,
    -- queued | running | done | failed | canceled
    state TEXT NOT NULL DEFAULT 'queued',
    -- descramble | cm | cut | encode。running の間、いまどの段階かを表す
    phase TEXT NOT NULL DEFAULT 'encode',
    percent REAL NOT NULL DEFAULT 0,
    eta_ms INTEGER,
    log TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS encode_jobs_state ON encode_jobs (state, id);
-- 録画一覧は1行ごとに「この録画の最新のジョブ」を2回引く (状態と失敗の理由)
CREATE INDEX IF NOT EXISTS encode_jobs_recording ON encode_jobs (recording_id, id);
`;
