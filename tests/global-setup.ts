import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { TEST_ROOT } from './stack';

/**
 * 前回の実行で残ったDB・録画ファイルを消してから、アプリを1度だけ組む。
 *
 * DBが残っていると前回の予約や録画が見えてしまい、件数の期待値が壊れる。
 *
 * アプリはワーカーの数だけ同時に立てる。開発サーバをその数だけ動かすと
 * 起動も動きも重くなるので、組んだものを共有して**それぞれ別のポートで**回す。
 * ついでに、本番と同じ adapter-node の出力を試すことになる。
 */
export default function globalSetup() {
    rmSync(TEST_ROOT, { recursive: true, force: true });

    const build = spawnSync('bun', ['run', 'build'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('ビルドに失敗しました');
}
