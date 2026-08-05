import { cpus } from 'node:os';
import { defineConfig } from '@playwright/test';

/** ワーカーの数。上限6の実測と理由は docs/development.md「並べて流す」 */
const WORKERS = Math.max(2, Math.min(6, cpus().length));

export default defineConfig({
    testDir: 'tests/e2e',
    // 並ぶのはファイル単位。中は順番 (前のテストが作った予約や録画を次が当てにしている)
    fullyParallel: false,
    workers: WORKERS,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    // ごく稀に落ちるのは中身ではなく混み具合。1回だけやり直す
    retries: 1,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    // 消してから、アプリを1度だけ組む。ワーカーはその出力を共有する
    globalSetup: './tests/global-setup.ts',
    use: {
        // baseURL はワーカーごとに違うので tests/stack.ts で入れる
        // 「端末に合わせる」がダークになる前提でテストする
        colorScheme: 'dark',
        trace: 'retain-on-failure',
        /*
         * **画面にもベーシック認証が掛かる。** 掛ける範囲を選べるのをやめて、
         * 掛けたら全部に掛かるようにしたため (docs/auth.md)。資格情報を持たない
         * ときの振る舞いを見たいテストは、そのテストで `httpCredentials: undefined`
         * を指定して外す
         */
        httpCredentials: { username: 'denpa', password: 'ひみつ' },
    },
});
