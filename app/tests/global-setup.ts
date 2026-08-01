import { mkdirSync, rmSync } from 'node:fs';
import { TEST_ROOT } from '../playwright.config';

/**
 * 前回の実行で残ったDB・録画ファイルを消す。
 * DBが残っていると前回の予約や録画が見えてしまい、件数の期待値が壊れる。
 */
export default function globalSetup() {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(`${TEST_ROOT}/recorded`, { recursive: true });
    mkdirSync(`${TEST_ROOT}/library`, { recursive: true });
}
