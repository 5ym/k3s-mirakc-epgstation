import { existsSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Recording } from '../types';
import { config } from './config';
import { removeIfExists } from './fsx';

/**
 * メタデータ(NFO)とサムネイルを、動画の隣にサイドカーとして置く。
 *
 * 日本の放送番組は TheTVDB / TMDB に載っていないものがほとんどで、Jellyfin の
 * インターネット取得に任せるとタイトルだけの一覧になってしまう。番組名・概要・
 * 放送日・放送局は EPG から取れているので、こちらから書いて渡す。
 *
 * Jellyfin 側ではライブラリの設定で NFO のメタデータ保存/読み込みを有効にし、
 * インターネットのメタデータ取得は切っておくと、ここで書いた内容が上書きされない。
 */

function xml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** サイドカーの置き場。`foo.mkv` に対して `foo.nfo` / `foo-thumb.jpg` */
export function sidecarPaths(videoPath: string): { nfo: string; thumbnail: string } {
    const base = videoPath.slice(0, videoPath.length - extname(videoPath).length);
    return { nfo: `${base}.nfo`, thumbnail: `${base}-thumb.jpg` };
}

/**
 * エピソードのNFO。日付ベースのエピソードとして扱わせるため aired を必ず入れる。
 * plot には概要(description)に加えて詳細情報(extended)も畳み込む。
 */
export function episodeNfo(recording: Recording): string {
    const start = new Date(recording.start_at);
    const aired = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    const runtime = Math.max(1, Math.round((recording.end_at - recording.start_at) / 60000));

    let extended = '';
    if (recording.description !== '') extended = recording.description;

    const lines = [
        '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
        '<episodedetails>',
        `  <title>${xml(recording.subtitle === '' ? recording.name : recording.subtitle)}</title>`,
        `  <showtitle>${xml(recording.series)}</showtitle>`,
        `  <plot>${xml(extended)}</plot>`,
        `  <aired>${aired}</aired>`,
        `  <premiered>${aired}</premiered>`,
        `  <runtime>${runtime}</runtime>`,
        `  <studio>${xml(recording.service_name)}</studio>`,
        // 再スキャンで別物として作り直されないよう、こちらのIDを持たせる
        `  <uniqueid type="denpa" default="true">${recording.id}</uniqueid>`,
        '</episodedetails>',
        '',
    ];
    return lines.join('\n');
}

/** シリーズのNFO。フォルダ名そのままだと Jellyfin が英題を探しに行くので明示する */
export function tvshowNfo(recording: Recording): string {
    return [
        '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
        '<tvshow>',
        `  <title>${xml(recording.series)}</title>`,
        `  <studio>${xml(recording.service_name)}</studio>`,
        '</tvshow>',
        '',
    ].join('\n');
}

/**
 * サムネイルを1枚切り出す。
 * 頭はたいてい提供表示やCMなので少し進めた位置から取る。番組が短いときは
 * 尺の1/3の位置にずらす(指定位置が尺を超えると ffmpeg が何も出力しないため)。
 */
export async function writeThumbnail(videoPath: string, durationSec: number): Promise<boolean> {
    const { thumbnail } = sidecarPaths(videoPath);
    const at =
        Number.isFinite(durationSec) && durationSec > 0
            ? Math.min(config.thumbnailPosition, durationSec / 3)
            : config.thumbnailPosition;

    const proc = Bun.spawn(
        [
            config.ffmpeg,
            '-y',
            '-ss',
            String(Math.max(0, at)),
            '-i',
            videoPath,
            '-frames:v',
            '1',
            '-vf',
            `scale=${config.thumbnailWidth}:-1`,
            thumbnail,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
    );
    const code = await proc.exited;
    return code === 0 && existsSync(thumbnail);
}

/** NFO を書く。動画を置いた直後に呼ぶ */
export function writeNfo(recording: Recording, videoPath: string): void {
    if (!config.writeNfo) return;
    const { nfo } = sidecarPaths(videoPath);
    writeFileSync(nfo, episodeNfo(recording));

    // シリーズのNFOは最初の1本のときだけ書く(既にあれば手で直した内容を尊重する)
    const showNfo = join(dirname(dirname(videoPath)), 'tvshow.nfo');
    if (!existsSync(showNfo)) writeFileSync(showNfo, tvshowNfo(recording));
}

/** 動画と一緒に消す。取り残すと Jellyfin に幽霊のエピソードが残る */
export function removeSidecars(videoPath: string | null): void {
    if (videoPath === null || videoPath === '') return;
    const { nfo, thumbnail } = sidecarPaths(videoPath);
    removeIfExists(nfo);
    removeIfExists(thumbnail);
}
