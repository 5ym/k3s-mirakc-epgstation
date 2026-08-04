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
    /** いま置いてある場所。焼き直しのとき、自分自身を「衝突」と読まないために要る */
    library_path?: string | null;
}

/**
 * 保存先での相対パスを組む。
 *
 * Kodi など .nfo を読むプレイヤーが期待する `シリーズ名/Season 年/シリーズ名 - YYYY-MM-DD ...`
 * という日付ベースのエピソード命名を解釈できる。日本の放送番組は話数が付かないもの・
 * 話数がリセットされるものが多く SxxExx に落とせないため、放送日をエピソード識別子に使う。
 *
 * 日時はコンテナの TZ (Asia/Tokyo) のローカル時刻。放送日で並ぶことが期待値なので UTC にはしない。
 */
function libraryRelPath(rec: LibraryNameInput, ext: string): string {
    const d = new Date(rec.start_at);
    const series = sanitizeFileName(rec.series);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;

    // 同一シリーズが同じ分に2本並ぶことはまず無いが、万一衝突したら録画IDで分ける
    const subtitle = rec.subtitle === '' ? '' : ` ${sanitizeFileName(rec.subtitle)}`;
    const base = `${series} - ${date} - ${time}${subtitle}`;

    return join(series, `Season ${d.getFullYear()}`, `${base}${ext}`);
}

/**
 * 絶対パス版。**別の録画のファイルと衝突したら**録画IDを足して避ける。
 *
 * **自分がいま置いてあるファイルは衝突ではない。** 見ずに `existsSync` だけで
 * 決めていた頃は、焼き直すたびに名前が入れ替わっていた:
 *
 * ```text
 * 1回目  番組 - 2026-08-03 - 2230.mkv       (空いているので素の名前)
 * 2回目  番組 - 2026-08-03 - 2230 [39].mkv  (1回目のものを「衝突」と読む)
 * 3回目  番組 - 2026-08-03 - 2230.mkv       (2回目が別名なので素の名前が空く)
 * ```
 *
 * 置き換えたあとに古いほうを消すので中身は無事だが、**焼き直すたびに
 * ファイル名が変わる**ので、プレイヤー側の見え方が毎回崩れる。
 */
export function libraryPath(rec: LibraryNameInput, ext: string): string {
    const rel = libraryRelPath(rec, ext);
    const abs = join(config.libraryDir, rel);
    if (!existsSync(abs) || abs === rec.library_path) return abs;
    return join(config.libraryDir, libraryRelPath(rec, ` [${rec.id}]${ext}`));
}

/** 生TSの置き場。保存先と違い人が見るものではないので平置きでよい */
export function recordedPath(rec: LibraryNameInput, ext = '.m2ts'): string {
    const d = new Date(rec.start_at);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return join(config.recordedDir, `${sanitizeFileName(rec.series)}-${stamp}-${rec.id}${ext}`);
}
