import { expect, test } from '@playwright/test';
import { MIRAKURUN_URL } from '../../playwright.config';
import { goto, reserveSoon, syncEpg } from './helpers';

/**
 * カードが読めていない状態で録れてしまったTSの扱い。
 *
 * 電波は二度と戻ってこないので、スクランブルされたままでも録画は止めない。
 * 代わりにエンコードの前に見て、掛かったままならその場で解く。
 */
test.describe('スクランブルされたまま録れたとき', () => {
    test.afterEach(async ({ request }) => {
        await request.post(`${MIRAKURUN_URL}/__control/scrambled?on=0`);
    });

    test('録画は止めず、エンコードの前に自動で解除する', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // カードが読めていない状態にする
        await request.post(`${MIRAKURUN_URL}/__control/scrambled?on=1`);

        const programId = await reserveSoon(page, request, 'BS');
        const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;

        // 録画自体は失敗しない。解除まで済んで視聴可能になる
        await expect(async () => {
            await goto(page, '/');
            await expect(page.locator(row).getByTestId('recording-state')).toHaveText('視聴可能');
        }).toPass({ timeout: 120_000 });

        await expect(page.locator(row).getByTestId('recording-error')).toHaveCount(0);
    });
});
