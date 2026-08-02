import { defineConfig } from '@playwright/test';

const APP_PORT = 4173;
const MIRAKC_PORT = 40772;
const WEBHOOK_PORT = 8096;

/** テスト用の作業領域。global-setup で毎回まっさらにする */
export const MIRAKC_URL = `http://127.0.0.1:${MIRAKC_PORT}`;
export const TEST_ROOT = '/tmp/denpa-e2e';
export const EPGSTATION_DIR = `${TEST_ROOT}/epgstation-recorded`;
export const LIBRARY_DIR = `${TEST_ROOT}/library`;
/** EPGStation の引き継ぎ元。マウント前後の見え方を試すので、あえて作らずに始める */
export const WEBHOOK_URL = `http://127.0.0.1:${WEBHOOK_PORT}`;

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
            command: `bun tests/fake/mirakc.ts`,
            url: `http://127.0.0.1:${MIRAKC_PORT}/api/version`,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            env: {
                FAKE_MIRAKC_PORT: String(MIRAKC_PORT),
                // 尺は tests/fake/services.ts で局ごとに決めている
                FAKE_SLOTS: '30',
                // スクランブル解除はパスだけ受け取って直接ファイルを触る。
                // 本物でも denpa と mirakc の両方に同じ置き場を見せている
                RECORDED_DIR: `${TEST_ROOT}/recorded`,
                LIBRARY_DIR,
            },
        },
        {
            command: `bun tests/fake/webhook.ts`,
            url: `${WEBHOOK_URL}/__control/state`,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            env: { FAKE_WEBHOOK_PORT: String(WEBHOOK_PORT) },
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
                // スクランブル解除の受け口。本物では mirakc と同じコンテナの
                // 別プロセスだが、偽 mirakc が同じ口を兼ねている
                TUNER_AGENT_URL: MIRAKC_URL,
                // 引き継ぎ画面。何も待ち受けていない先を指して、失敗したときの見え方も試す
                EPGSTATION_RECORDED_DIR: EPGSTATION_DIR,
                EPGSTATION_DB_HOST: '127.0.0.1',
                EPGSTATION_DB_PORT: '1',
                FAKE_FFMPEG_FAIL_FILE: `${TEST_ROOT}/fail-encode`,
                MIRAKC_URL,
                // 定期処理は止め、テストからボタン/APIで明示的に走らせる(タイミング依存を避ける)
                RECONCILE_INTERVAL: '86400000',
                EPG_SYNC_INTERVAL: '86400000',
                SCHEDULER_TICK: '500',
                START_MARGIN: '0',
                END_MARGIN: '500',
                ENCODE_CONCURRENCY: '2',
                // 何も待ち受けていない先。引き継ぎが失敗したときの見え方を試す
                // ベーシック認証は設定画面から入れる。env は初期値として使えることの確認用
                BASIC_AUTH_USER: 'denpa',
                BASIC_AUTH_PASSWORD: 'ひみつ',
            },
        },
    ],
});
