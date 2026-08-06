/**
 * ライブ視聴で、サーバとブラウザが取り決めていること。**両側から読む。**
 *
 * 1本の WebSocket に全部を相乗りさせる ([stream.md](../../docs/stream.md) §5.3)。
 *
 *     [1 byte: 種別][8 bytes: PTS (90kHz, BE)][中身...]
 *
 * PTS は元TSの時間軸そのまま (`-copyts`)。字幕とデータ放送を映像と同じ物差しで
 * 並べるために要る。映像音声だけは fMP4 の timescale で勝手に揃うので、
 * そちらでは使わない。
 */

/** 多重化の種別。番号は stream.md §5.3 の表そのまま */
export const CHANNEL = {
    /** 映像の init セグメント (ftyp + moov) */
    videoInit: 0x00,
    /** 映像の中身 (moof + mdat) */
    videoMedia: 0x01,
    /** 音声の init セグメント。**第1段階では使わない** (映像と同じ器に入れている) */
    audioInit: 0x10,
    /** 音声の中身。同上 */
    audioMedia: 0x11,
    /** 字幕の絵。第2段階 */
    subtitle: 0x20,
    /** 字幕を消す。第2段階 */
    subtitleClear: 0x21,
    /** データ放送。第3段階 */
    data: 0x30,
    /** 制御。**ここだけ双方向**で、中身は JSON */
    control: 0x40,
} as const;

/** サーバ→ブラウザの知らせ。`control` に JSON で載る */
export type Notice =
    | { type: 'tuned'; channelType: string; channel: string; codecs: string }
    | { type: 'error'; message: string };

/**
 * ブラウザ→サーバの指示。
 *
 * **局まで渡す。** 物理チャンネルだけでは、いま流れている番組が引けない
 * (1本の中に複数の局が乗っている)。番組が引けないと、インタレ解除で
 * コマ数を倍にするかどうかを決められない (国内アニメだけ倍にしない)。
 */
export type Command = { type: 'tune'; channelType: string; channel: string; serviceId: number };

/** WebSocket の宛先 */
export const SOCKET_PATH = '/api/live/socket';
