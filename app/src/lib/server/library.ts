import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config';
import { sanitizeFileName } from './title';

function pad(n: number, width = 2): string {
    return String(n).padStart(width, '0');
}

export interface LibraryNameInput {
    id: number;
    series: string;
    subtitle: string;
    start_at: number;
}

/**
 * ライブラリ内での相対パスを組む。
 *
 * Kodi など .nfo を読むプレイヤーが期待する `シリーズ名/Season 年/シリーズ名 - YYYY-MM-DD ...`
 * という日付ベースのエピソード命名を解釈できる。日本の放送番組は話数が付かないもの・
 * 話数がリセットされるものが多く SxxExx に落とせないため、放送日をエピソード識別子に使う。
 *
 * 日時はコンテナの TZ (Asia/Tokyo) のローカル時刻。放送日で並ぶことが期待値なので UTC にはしない。
 */
export function libraryRelPath(rec: LibraryNameInput, ext: string): string {
    const d = new Date(rec.start_at);
    const series = sanitizeFileName(rec.series);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;

    // 同一シリーズが同じ分に2本並ぶことはまず無いが、万一衝突したら録画IDで分ける
    const subtitle = rec.subtitle === '' ? '' : ` ${sanitizeFileName(rec.subtitle)}`;
    const base = `${series} - ${date} - ${time}${subtitle}`;

    return join(series, `Season ${d.getFullYear()}`, `${base}${ext}`);
}

/** 絶対パス版。既存ファイルと衝突したら録画IDを足して避ける */
export function libraryPath(rec: LibraryNameInput, ext: string): string {
    const rel = libraryRelPath(rec, ext);
    const abs = join(config.libraryDir, rel);
    if (!existsSync(abs)) return abs;
    return join(config.libraryDir, libraryRelPath(rec, ` [${rec.id}]${ext}`));
}

/** 生TSの置き場。ライブラリと違い人が見るものではないので平置きでよい */
export function recordedPath(rec: LibraryNameInput): string {
    const d = new Date(rec.start_at);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return join(config.recordedDir, `${sanitizeFileName(rec.series)}-${stamp}-${rec.id}.m2ts`);
}
