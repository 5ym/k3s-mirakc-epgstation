import { rmSync } from 'node:fs';
import { expect, goto, recordOne, test } from './helpers';

/**
 * 録画ファイルを denpa の外から消したときに、一覧からも消えることを確認する。
 * ファイルマネージャや別のマシンから消されることがあるので、
 * ここでも同じようにファイルを消して、denpa がそれを拾えるかを見る。
 */
test.describe('外で消された録画の反映', () => {
    test('外で消した録画が一覧から消え、削除済みとして残る', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        const { id: recordingId, libraryPath } = await recordOne(page, request);
        expect(libraryPath).toContain(stack.libraryDir);

        // ファイルが在るうちは照合しても何も起きない
        await page.getByTestId('reconcile-button').click();
        await expect(page.getByTestId('reconcile-result')).toContainText('削除済み 0 件');
        await expect(page.locator(`[data-recording-id="${recordingId}"]`)).toHaveCount(1);

        // 外から消されたのと同じことをする
        rmSync(libraryPath);

        await page.getByTestId('reconcile-button').click();
        await expect(page.getByTestId('reconcile-result')).toContainText('削除済み 1 件');

        // 現存一覧からは消え、「削除済みも表示」にすると履歴として残っている
        await goto(page, '/');
        await expect(page.locator(`[data-recording-id="${recordingId}"]`)).toHaveCount(0);

        await goto(page, '/?deleted=1');
        const row = page.locator(`[data-recording-id="${recordingId}"]`);
        await expect(row).toContainText('削除済み');

        // 消えた理由は行ではなく詳細に出す (生の文言で行が分厚くならないように)
        await row.getByTestId('detail-button').click();
        await expect(page.getByTestId('detail-error')).toContainText('保存先から消えていました');
    });
});
