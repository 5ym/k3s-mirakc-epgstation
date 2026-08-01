/** スキーマは TS の文字列として持つ。?raw インポートに頼らないので、
 * vite のビルド経由でも bun test の直接実行でも同じように読める。
 */
export const SCHEMA = `
-- 全て CREATE ... IF NOT EXISTS で書き、起動のたびに流す。
-- 列を足すときは末尾に ALTER TABLE ... ADD COLUMN を追記していく方針
-- (単一ノード・単一プロセスの個人用途なのでマイグレーションツールは持たない)。

-- 画面から変えられる設定。環境変数を初期値として、ここにあれば上書きする。
-- Jellyfin のURLとAPIキーは「起動前に用意しておく」のが現実的でないのでここに置く。
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY,           -- Mirakurun の service id
    service_id INTEGER NOT NULL,
    network_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,               -- GR / BS / CS
    channel TEXT NOT NULL,            -- 物理チャンネル。同一チャンネルの同時録画はチューナーを共有できる
    remote_control_key INTEGER,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY,           -- Mirakurun の program id
    service_id INTEGER NOT NULL,
    network_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    extended TEXT,                    -- JSON
    genres TEXT,                      -- JSON: lv1 の配列
    is_free INTEGER NOT NULL DEFAULT 1,
    audio_type INTEGER,               -- ARIB の componentType。2 がデュアルモノ
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS programs_time ON programs (start_at, end_at);
CREATE INDEX IF NOT EXISTS programs_service_time ON programs (service_id, start_at);

CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    keyword TEXT NOT NULL DEFAULT '',
    ignore_keyword TEXT NOT NULL DEFAULT '',
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
    -- scheduled | conflict | recording | done | failed | canceled
    state TEXT NOT NULL DEFAULT 'scheduled',
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
    series TEXT NOT NULL DEFAULT '',   -- Jellyfin 上でシリーズとしてまとめる単位
    subtitle TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    audio_type INTEGER,
    ts_path TEXT,
    ts_size INTEGER NOT NULL DEFAULT 0,
    library_path TEXT,
    -- recording | recorded | encoding | available | failed
    state TEXT NOT NULL,
    error TEXT,
    keep_original INTEGER NOT NULL DEFAULT 0,
    -- off / chapter / cut
    cm_cut TEXT NOT NULL DEFAULT 'chapter',
    codec TEXT NOT NULL DEFAULT 'av1',
    cm_ranges TEXT,   -- 検出したCM区間の JSON。UIでの確認用
    -- Jellyfin 側で消された、または denpa から消した時刻。行は履歴として残す
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS recordings_state ON recordings (state);
CREATE INDEX IF NOT EXISTS recordings_start ON recordings (start_at DESC);

CREATE TABLE IF NOT EXISTS encode_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id INTEGER NOT NULL,
    -- queued | running | done | failed | canceled
    state TEXT NOT NULL DEFAULT 'queued',
    percent REAL NOT NULL DEFAULT 0,
    log TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS encode_jobs_state ON encode_jobs (state, id);
`;
