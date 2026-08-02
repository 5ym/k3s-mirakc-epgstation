/**
 * 「この録画は録り直せるか」の判定。画面とサーバの両方で使う。
 *
 * 元にできるのは**生TSだけ**。エンコード済みを元に録り直しても画質は戻らないので、
 * 元が無いものには再エンコードを出さない。
 *
 * 生TSは2か所にある。
 *
 * - ts_path … denpa が録ったもの。エンコードが終わると(残す設定でなければ)消える
 * - library_path … 引き継いだ録画。EPGStation 側でエンコードが済んでいなかったものは
 *   中身が生TSのまま保存先に置かれ、ts_path は持たない
 */

/** 生TSとして扱う拡張子。放送波をそのまま入れた入れ物の呼び名がいくつかある */
const RAW_TS = ['.ts', '.m2ts', '.mts', '.m2t'];

export function isRawTs(path: string | null | undefined): boolean {
    if (!path) return false;
    const lower = path.toLowerCase();
    return RAW_TS.some((extension) => lower.endsWith(extension));
}

/** エンコードの元にできるファイル。無ければ null */
export function encodeSource(recording: {
    ts_path: string | null;
    library_path: string | null;
}): string | null {
    if (recording.ts_path !== null) return recording.ts_path;
    return isRawTs(recording.library_path) ? recording.library_path : null;
}
