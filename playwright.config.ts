import { cpus } from 'node:os';
import { defineConfig } from '@playwright/test';

/*
 * ワーカーの数。
 *
 * 1つ増えるごとに denpa と偽 mirakc と偽通知先が1式ずつ増える (tests/stack.ts)。
 * 録画とエンコードを実時間で回すので、CPU の数より控えめにしないと
 * かえって遅くなる。半分を上限4で頭打ちにする
 */
const WORKERS = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));

export default defineConfig({
    testDir: 'tests/e2e',
    /*
     * ファイルの中は今までどおり順番に流す。
     * 1つのファイルの中では、前のテストが作った予約や録画を次のテストが当てにしている。
     *
     * 並ぶのはファイル単位。ワーカーごとにアプリもDBも別なので、
     * 同時に走っているファイル同士は互いに見えない
     */
    fullyParallel: false,
    workers: WORKERS,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    // 消してから、アプリを1度だけ組む。ワーカーはその出力を共有する
    globalSetup: './tests/global-setup.ts',
    use: {
        // baseURL はワーカーごとに違うので tests/stack.ts で入れる
        // 「端末に合わせる」がダークになる前提でテストする
        colorScheme: 'dark',
        trace: 'retain-on-failure',
    },
});
