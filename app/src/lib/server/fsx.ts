import { copyFileSync, existsSync, mkdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';

/**
 * 生TSと保存先は別PVCなので rename が EXDEV で失敗する。
 * その場合だけコピー+削除にフォールバックする。
 */
export function moveFile(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    try {
        renameSync(from, to);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        copyFileSync(from, to);
        unlinkSync(from);
    }
}

export function removeIfExists(path: string | null | undefined): boolean {
    if (path == null || path === '') return false;
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
}

/**
 * ファイルを消した後に空になったシリーズ/シーズンのフォルダを畳む。
 * 残しておくと、フォルダを辿るプレイヤーに中身の無いシリーズが並び続けるため。
 * libraryDir 自身より上には絶対に遡らない。
 */
export function pruneEmptyDirs(path: string): void {
    let dir = dirname(path);
    while (dir.startsWith(config.libraryDir) && dir !== config.libraryDir) {
        try {
            rmdirSync(dir);
        } catch {
            // 空でなければここで止まる。それが正常な終了条件
            return;
        }
        dir = dirname(dir);
    }
}
