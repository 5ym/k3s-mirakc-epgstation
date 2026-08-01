import { defineConfig } from '@playwright/test';

const APP_PORT = 4173;
const MIRAKURUN_PORT = 40772;
const JELLYFIN_PORT = 8096;

/** テスト用の作業領域。global-setup で毎回まっさらにする */
export const TEST_ROOT = '/tmp/denpa-e2e';
export const LIBRARY_DIR = `${TEST_ROOT}/library`;
export const JELLYFIN_URL = `http://127.0.0.1:${JELLYFIN_PORT}`;

export default defineConfig({
    testDir: 'tests/e2e',
    // 1つのアプリ・1つのDBを共有するので直列に流す
    fullyParallel: false,
    workers: 1,
    timeout: 120_000,
    expect: { timeout: 30_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    globalSetup: './tests/global-setup.ts',
    use: {
        baseURL: `http://127.0.0.1:${APP_PORT}`,
        // 「端末に合わせる」がダークになる前提でテストする
        colorScheme: 'dark',
        trace: 'retain-on-failure',
    },
    webServer: [
        {
            command: `bun tests/fake/mirakurun.ts`,
            url: `http://127.0.0.1:${MIRAKURUN_PORT}/api/version`,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
                FAKE_MIRAKURUN_PORT: String(MIRAKURUN_PORT),
                // 10秒番組にして、E2Eの中で録画完了まで待てるようにする
                FAKE_SLOT_MS: '10000',
                FAKE_SLOTS: '30',
            },
        },
        {
            command: `bun tests/fake/jellyfin.ts`,
            url: `${JELLYFIN_URL}/__control/state`,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            env: { FAKE_JELLYFIN_PORT: String(JELLYFIN_PORT) },
        },
        {
            command: `bun run dev --port ${APP_PORT} --host 127.0.0.1 --strictPort`,
            url: `http://127.0.0.1:${APP_PORT}/api/health`,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 120_000,
            env: {
                TZ: 'Asia/Tokyo',
                DENPA_DB: `${TEST_ROOT}/denpa.db`,
                // 明示的に切った中継だけを見たいので、アイドル回収は長めに
                LIVE_IDLE_TIMEOUT: '600000',
                RECORDED_DIR: `${TEST_ROOT}/recorded`,
                LIBRARY_DIR,
                FFMPEG: './tests/fake/ffmpeg.sh',
                MIRAKURUN_URL: `http://127.0.0.1:${MIRAKURUN_PORT}`,
                JELLYFIN_URL,
                JELLYFIN_API_KEY: 'e2e',
                // 定期処理は止め、テストからボタン/APIで明示的に走らせる(タイミング依存を避ける)
                RECONCILE_INTERVAL: '86400000',
                EPG_SYNC_INTERVAL: '86400000',
                SCHEDULER_TICK: '500',
                START_MARGIN: '0',
                END_MARGIN: '500',
                ENCODE_CONCURRENCY: '2',
            },
        },
    ],
});
