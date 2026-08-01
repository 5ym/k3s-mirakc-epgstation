import { expect, test } from '@playwright/test';
import { JELLYFIN_URL } from '../../playwright.config';
import { goto, syncEpg } from './helpers';

/**
 * Jellyfin のライブTV画面で録画ボタンを押すと Jellyfin にタイマーが作られる。
 * それを denpa の予約に取り込んで、Jellyfin 側のタイマーは消す、という流れ。
 *
 * タイマー作成を知らせるWebhookが無いため定期的に見に行く仕組みだが、
 * テストでは「今すぐ取り込む」ボタンで明示的に走らせる。
 */
test.describe('Jellyfin の録画予約の取り込み', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
        await request.post(`${JELLYFIN_URL}/__control/reset`);
    });

    test('タイマーが予約になり、Jellyfin 側からは消える', async ({ page, request }) => {
        // 十分先の枠を指すタイマーを作る(すぐ録画が始まらないように)
        const start = Date.now() + 120_000;
        await request.post(`${JELLYFIN_URL}/__control/timer`, {
            data: {
                ChannelName: 'TOKYO MX',
                Name: '録画ボタンで作られたタイマー',
                StartDate: new Date(start).toISOString(),
                EndDate: new Date(start + 10_000).toISOString(),
            },
        });

        await goto(page, '/reservations');
        const before = await page.getByTestId('reservation-row').count();

        await page.getByTestId('import-timers').click();
        await expect(page.getByTestId('import-result')).toContainText('取り込み 1 件');

        await expect(page.getByTestId('reservation-row')).toHaveCount(before + 1);

        // 取り込んだらJellyfin側のタイマーは消す。残すと二重に録ろうとする
        const state = await (await request.get(`${JELLYFIN_URL}/__control/state`)).json();
        expect(state.timers).toHaveLength(0);

        // 後続に影響しないよう片付ける
        await page.getByTestId('reservation-row').first().getByTestId('cancel-button').click();
    });

    test('前後マージンが乗っていても番組を特定できる', async ({ page, request }) => {
        const start = Date.now() + 180_000;
        await request.post(`${JELLYFIN_URL}/__control/timer`, {
            data: {
                ChannelName: 'フジテレビ',
                Name: 'マージン付き',
                // Jellyfin は前後にマージンを足したうえでタイマーを作る
                StartDate: new Date(start - 60_000).toISOString(),
                EndDate: new Date(start + 10_000 + 60_000).toISOString(),
                PrePaddingSeconds: 60,
                PostPaddingSeconds: 60,
            },
        });

        await goto(page, '/reservations');
        await page.getByTestId('import-timers').click();
        await expect(page.getByTestId('import-result')).toContainText('取り込み 1 件');
        await page.getByTestId('reservation-row').first().getByTestId('cancel-button').click();
    });

    test('シリーズ録画は対象外にする', async ({ page, request }) => {
        const start = Date.now() + 240_000;
        await request.post(`${JELLYFIN_URL}/__control/timer`, {
            data: {
                ChannelName: 'TOKYO MX',
                Name: 'シリーズ録画',
                StartDate: new Date(start).toISOString(),
                EndDate: new Date(start + 10_000).toISOString(),
                SeriesTimerId: 'series-1',
            },
        });

        await goto(page, '/reservations');
        await page.getByTestId('import-timers').click();
        await expect(page.getByTestId('import-result')).toContainText('対象外 1 件');

        // 消さずに残す。消しても Jellyfin が作り直すので取り合いになる
        const state = await (await request.get(`${JELLYFIN_URL}/__control/state`)).json();
        expect(state.timers).toHaveLength(1);
    });

    test('番組を特定できないタイマーは Jellyfin 側に残す', async ({ page, request }) => {
        await request.post(`${JELLYFIN_URL}/__control/timer`, {
            data: {
                ChannelName: '存在しない局',
                Name: '知らない番組',
                StartDate: new Date(Date.now() + 300_000).toISOString(),
                EndDate: new Date(Date.now() + 310_000).toISOString(),
            },
        });

        await goto(page, '/reservations');
        await page.getByTestId('import-timers').click();
        const result = page.getByTestId('import-result');
        await expect(result).toContainText('失敗 1 件');
        await expect(result).toContainText('番組を特定できませんでした');

        // 録り逃さないよう、失敗したタイマーは消さない
        const state = await (await request.get(`${JELLYFIN_URL}/__control/state`)).json();
        expect(state.timers).toHaveLength(1);
    });
});
