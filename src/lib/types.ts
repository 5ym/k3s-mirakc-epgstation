export type ChannelType = 'GR' | 'BS' | 'CS' | 'SKY';

/**
 * 番組詳細に出す分。番組表・予約一覧・録画一覧のどこから開いても同じ形で見せる。
 * 予約や録画からは局名しか手元に無いので、局IDではなく名前で持つ。
 */
export interface ProgramDetail {
    name: string;
    service_name: string;
    start_at: number;
    end_at: number;
    description: string;
    extended: string | null;
    genre_detail: string | null;
    audios: string | null;
    video_type: string | null;
    video_resolution: string | null;
    is_free: number;
}

/**
 * CMの扱い。
 * off     : 何もしない
 * chapter : CM区間をチャプターとして書き込むだけ(ファイルは切らない)
 * cut     : CM区間を実際に落とす。検出を誤ると本編が消えるので明示指定のときだけ
 */
export type CmMode = 'off' | 'chapter' | 'cut';

/**
 * 録画をどう出すか。
 *
 * av1  : 既定。同じ画質でファイルが小さいが、エンコードに時間がかかる
 * h264 : エンコードが速く、非力なマシンや古いクライアント向け
 * none : **エンコードしない。** 生TSのまま保存先へ置く
 *
 * 別に「エンコードする」のチェックを持っていた頃は、外したときにコーデックの
 * 選択だけが残って、どちらが効いているのか画面から読めなかった。選ぶものは1つでいい
 */
export type VideoCodec = 'av1' | 'h264' | 'none';

export interface Service {
    id: number;
    service_id: number;
    network_id: number;
    name: string;
    type: ChannelType;
    /** ARIB のサービス種別。1 がデジタルTV */
    service_type: number;
    channel: string;
    remote_control_key: number | null;
    has_logo: number;
    /** 局ロゴの位置 ("x,y,w,h")。CM検出 (jls) で自動検出できなかった局だけ手で入れる */
    logo_area: string | null;
    updated_at: number;
}

export interface Program {
    id: number;
    service_id: number;
    network_id: number;
    event_id: number;
    start_at: number;
    end_at: number;
    name: string;
    description: string;
    extended: string | null;
    genres: string | null;
    genre_detail: string | null;
    is_free: number;
    audio_type: number | null;
    audios: string | null;
    video_type: string | null;
    video_resolution: string | null;
    updated_at: number;
}

export interface Rule {
    id: number;
    name: string;
    keyword: string;
    ignore_keyword: string;
    /** キーワードを当てる範囲。SearchField のカンマ区切り */
    search_fields: string;
    service_ids: string | null;
    service_types: string | null;
    genres: string | null;
    enabled: number;
    /**
     * チューナーが足りないとき、どの予約を残すか。大きいほうが残る。
     * **エージェントに渡す「掴む強さ」とは別物**
     */
    priority: number;
    /** 引き継ぎ元での識別子 (例: epgstation:12)。自分で作ったものは NULL */
    source: string | null;
    created_at: number;
}

/**
 * 予約の状態。
 *
 * DBの列に入っているのは `scheduled | conflict | canceled | missed` だけ。
 * 録り始めてからの `recording | done | failed` は**録画の行から引いた結果**で、
 * 一覧を組み立てるときに足す (routes/+page.server.ts)。
 * 予約側にも書き写していた頃は、録画が失敗しても予約は録画中のまま残っていた
 */
export type ReservationState =
    | 'scheduled'
    | 'conflict'
    | 'canceled'
    | 'missed'
    | 'recording'
    | 'done'
    | 'failed';

export interface Reservation {
    id: number;
    program_id: number;
    rule_id: number | null;
    service_id: number;
    name: string;
    description: string;
    start_at: number;
    end_at: number;
    priority: number;
    manual: number;
    encode: number;
    keep_original: number;
    cm_cut: CmMode;
    codec: VideoCodec;
    state: ReservationState;
    /** 録り始めた時刻。null なら**まだ始めていない**。二重に始めないための鍵でもある */
    started_at: number | null;
    conflict_reason: string | null;
    created_at: number;
    updated_at: number;
}

/**
 * 録画の状態。**列ではなく生成列**で、他の列から毎回決まる (schema.RECORDING_STATE)。
 *
 * `encoding` はここに無い。動いているエンコードは encode_jobs にしか無く、
 * 一覧はそれを見て「エンコード中」を出す (format.encodeLabel)
 */
export type RecordingState = 'recording' | 'recorded' | 'available' | 'failed' | 'deleted';

export interface Recording {
    id: number;
    reservation_id: number | null;
    program_id: number | null;
    service_id: number;
    service_name: string;
    name: string;
    series: string;
    subtitle: string;
    description: string;
    start_at: number;
    end_at: number;
    audio_type: number | null;
    ts_path: string | null;
    ts_size: number;
    library_path: string | null;
    /** 録り終えた時刻。null なら**まだ掴んでいる最中** */
    finished_at: number | null;
    state: RecordingState;
    /** 録画そのものが失敗した理由 (消したときは削除の理由)。エンコードの失敗は入らない */
    error: string | null;
    keep_original: number;
    cm_cut: CmMode;
    codec: VideoCodec;
    cm_ranges: string | null;
    /** 番組表から写したジャンル (JSON: [{lv1, lv2}])。エンコードのコマ数を決めるのに使う */
    genre_detail: string | null;
    /**
     * CM検出が何をしたか。詳細で見せる。
     *
     * **ロゴを使えたかどうかもここから読む** (`format.logoUnusable`)。別の列で
     * 持っていた頃は、後から条件を広げても既に録ってある分には効かなかった
     */
    cm_note: string | null;
    /** 実際に録れた長さ。取れていなければ null (古い行) */
    duration_ms: number | null;
    deleted_at: number | null;
    acknowledged_at: number | null;
    created_at: number;
    updated_at: number;
}

export type EncodeState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

/**
 * エンコードの段階。`encode` 以外は ffmpeg が回る前の下ごしらえで、
 * 進み具合が出せない代わりにこれを状態として出す。
 */
export type EncodePhase = 'descramble' | 'cm' | 'cut' | 'encode';

export interface EncodeJob {
    id: number;
    recording_id: number;
    state: EncodeState;
    phase: EncodePhase;
    percent: number;
    /** 残り時間の見込み(ms)。分からない間は null */
    eta_ms: number | null;
    log: string;
    attempts: number;
    error: string | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
}
