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
 * 録画のエンコードに使う映像コーデック。
 * av1  : 既定。同じ画質でファイルが小さいが、エンコードに時間がかかる
 * h264 : エンコードが速く、非力なマシンや古いクライアント向け
 */
export type VideoCodec = 'av1' | 'h264';

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
    service_ids: string | null;
    service_types: string | null;
    genres: string | null;
    free_only: number;
    enabled: number;
    priority: number;
    encode: number;
    keep_original: number;
    cm_cut: CmMode;
    codec: VideoCodec;
    /** 引き継ぎ元での識別子 (例: epgstation:12)。自分で作ったものは NULL */
    source: string | null;
    created_at: number;
}

export type ReservationState = 'scheduled' | 'conflict' | 'recording' | 'done' | 'failed' | 'canceled';

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
    conflict_reason: string | null;
    created_at: number;
    updated_at: number;
}

export type RecordingState = 'recording' | 'recorded' | 'encoding' | 'available' | 'failed';

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
    state: RecordingState;
    error: string | null;
    keep_original: number;
    cm_cut: CmMode;
    codec: VideoCodec;
    cm_ranges: string | null;
    deleted_at: number | null;
    acknowledged_at: number | null;
    created_at: number;
    updated_at: number;
}

export type EncodeState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface EncodeJob {
    id: number;
    recording_id: number;
    state: EncodeState;
    percent: number;
    log: string;
    attempts: number;
    error: string | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
}
