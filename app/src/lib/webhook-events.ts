/** 通知の種類。画面でも使うのでサーバ専用モジュールには置かない */
export const EVENTS = [
    'recording.started',
    'recording.finished',
    'recording.failed',
    'encode.finished',
    'encode.failed',
] as const;

export type WebhookEvent = (typeof EVENTS)[number];

export const EVENT_LABEL: Record<string, string> = {
    'recording.started': '録画開始',
    'recording.finished': '録画完了',
    'recording.failed': '録画失敗',
    'encode.finished': 'エンコード完了',
    'encode.failed': 'エンコード失敗',
};
