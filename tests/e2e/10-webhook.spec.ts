import { expect, goto, syncEpg, test } from './helpers';

/**
 * 録画の節目を外部に飛ばす。
 * 録画の失敗は画面を開くまで気づけないので、届くことをここで確かめておく。
 */
test.describe('通知', () => {
    test.beforeEach(async ({ page, request, stack }) => {
        await syncEpg(request);
        await request.post(`${stack.webhookUrl}/__control/reset`);
        // 前のテストが残した通知先を消す
        await goto(page, '/settings');
        for (let i = 0; i < 10; i++) {
            const buttons = page.getByTestId('webhook-delete');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(100);
        }
    });

    test('通知先を追加してテスト送信すると、相手に届く', async ({ page, request, stack }) => {
        await goto(page, '/settings');
        await page.getByTestId('webhook-url').fill(`${stack.webhookUrl}/__control/webhook`);
        await page.getByTestId('webhook-add').click();

        const row = page.getByTestId('webhook-row').first();
        await expect(row).toContainText('/__control/webhook');
        // 何も選ばなければ全部送る
        await expect(row).toContainText('すべて');
        await expect(row).toContainText('未送信');

        await row.getByTestId('webhook-test').click();
        await expect(page.getByTestId('webhook-tested')).toContainText('ok');

        const state = await (await request.get(`${stack.webhookUrl}/__control/state`)).json();
        expect(state.webhookCalls).toHaveLength(1);
        expect(state.webhookCalls[0].event).toBe('recording.finished');
        expect(state.webhookCalls[0].text).toContain('テスト送信');

        // 直近の結果が残る。届いていないことに気づけるように
        await expect(page.getByTestId('webhook-row').first()).toContainText('ok');
    });

    test('送る通知を選べる', async ({ page, stack }) => {
        await goto(page, '/settings');
        await page.getByTestId('webhook-url').fill(`${stack.webhookUrl}/__control/webhook`);
        await page.getByTestId('webhook-events').locator('input[value="recording.failed"]').check();
        await page.getByTestId('webhook-add').click();

        const row = page.getByTestId('webhook-row').first();
        await expect(row).toContainText('録画失敗');
        await expect(row).not.toContainText('すべて');
    });

    test('URLが不正なら断る', async ({ page }) => {
        await goto(page, '/settings');
        await page.getByTestId('webhook-url').fill('not-a-url');
        await page.getByTestId('webhook-add').click();
        await expect(page.getByTestId('settings-error')).toContainText('http(s) で始まるURL');
        await expect(page.getByTestId('webhook-row')).toHaveCount(0);
    });

    test('無効にした通知先には送らない', async ({ page, request, stack }) => {
        await goto(page, '/settings');
        await page.getByTestId('webhook-url').fill(`${stack.webhookUrl}/__control/webhook`);
        await page.getByTestId('webhook-add').click();
        await page.getByTestId('webhook-toggle').first().click();
        await expect(page.getByTestId('webhook-row').first()).toContainText('無効');

        // 無効でもテスト送信は通る(疎通確認のため)。届かないのは自動の通知のほう
        const state = await (await request.get(`${stack.webhookUrl}/__control/state`)).json();
        expect(state.webhookCalls).toHaveLength(0);
    });
});
