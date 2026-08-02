import { cpus } from 'node:os';
import { defineConfig } from '@playwright/test';

/*
 * ワーカーの数。
 *
 * 1つ増えるごとに denpa と偽 mirakc と偽通知先が1式ずつ増える (tests/stack.ts)。
 * 待っている時間 (偽の放送が終わるまで) が大半なので、CPU の数ぴったりにする
 * 必要はない。実測では12コアで **4 → 6 にすると 1分43秒が59秒**になり、
 * 8 まで増やすと取り合いで落ちるものが出た。半分を上限6で頭打ちにする
 */
const WORKERS = Math.max(2, Math.min(6, Math.ceil(cpus().length / 2)));

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
    // ワーカーを増やすと、ごく稀にブラウザ側が落ちる。CI で1回だけやり直す
    retries: process.env.CI ? 1 : 0,
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
