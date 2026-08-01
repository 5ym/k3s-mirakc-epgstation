import { rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { goto } from './helpers';

/**
 * Jellyfin の UI から録画を消したときに、denpa の一覧からも消えることを確認する。
 * Jellyfin はライブラリを読み書きでマウントしてファイルを直接消すので、
 * ここでも同じようにファイルを消して、denpa の照合がそれを拾えるかを見る。
 *
 * 03 のテストがライブラリに入れた1本をそのまま使う。
 */
test.describe('Jellyfin 側での削除の反映', () => {
    test('Jellyfinで消した録画が一覧から消え、削除済みとして残る', async ({ page }) => {
        await goto(page, '/recordings');
        const recording = page.getByTestId('recording-row').first();
        await expect(recording).toBeVisible();

        const recordingId = await recording.getAttribute('data-recording-id');
        const libraryPath = ((await recording.locator('span.font-mono').first().textContent()) ?? '').trim();
        expect(libraryPath).toContain('/tmp/denpa-e2e/library/');

        // ファイルが在るうちは照合しても何も起きない
        await page.getByTestId('reconcile-button').click();
        await expect(page.getByTestId('reconcile-result')).toContainText('削除済み 0 件');
        await expect(page.locator(`[data-recording-id="${recordingId}"]`)).toHaveCount(1);

        // Jellyfin が消したのと同じことをする
        rmSync(libraryPath);

        await page.getByTestId('reconcile-button').click();
        await expect(page.getByTestId('reconcile-result')).toContainText('削除済み 1 件');

        // 現存一覧からは消え、削除済み一覧に理由付きで残る
        await goto(page, '/recordings');
        await expect(page.locator(`[data-recording-id="${recordingId}"]`)).toHaveCount(0);

        await goto(page, '/recordings?deleted=1');
        await expect(page.locator(`[data-recording-id="${recordingId}"]`)).toContainText(
            'Jellyfin 側で削除されました',
        );
    });
});
