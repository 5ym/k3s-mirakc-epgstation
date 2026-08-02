import { expect, test } from '@playwright/test';
import { goto, syncEpg } from './helpers';

/**
 * チャンネルスキャン。
 *
 * 走らせるのは Mirakurun 側で、結果も Mirakurun が自分の channels.yml に
 * 書き戻す。denpa は開始を投げて進み具合を見せるだけ。
 */
test.describe('チャンネルスキャン', () => {
    test('番組表から実行でき、進み具合と結果が出る', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/guide');

        await page.getByTestId('scan-open').click();
        const dialog = page.getByTestId('scan-dialog');
        await expect(dialog).toBeVisible();

        // 何分もかかってチューナーを全部使うので、そうと分かるようにしておく
        await expect(dialog).toContainText('チューナーを全部使う');

        await dialog.getByTestId('scan-type').selectOption('GR');
        await dialog.getByTestId('scan-start').click();

        await expect(dialog.getByTestId('scan-state')).toHaveText('完了', { timeout: 30_000 });
        // 見つけた行だけ数える。信号が無かった分は数に入らない
        await expect(dialog.getByTestId('scan-found')).toContainText('2');
        await expect(dialog.getByTestId('scan-log')).toContainText('scan finished');

        await dialog.getByTestId('scan-close').click();
        await expect(dialog).toHaveCount(0);
    });
});
