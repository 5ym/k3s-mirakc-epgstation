import { expect, test } from '@playwright/test';
import { BS11 } from '../fake/services';
import { goto, syncEpg } from './helpers';

test.describe('自動予約ルール', () => {
    test('条件が空のルールは作れない', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('rule-name').fill('条件なし');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-error')).toContainText(
            'キーワードかチャンネルのどちらかは指定してください',
        );
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
    });

    test('キーワードルールを作ると予約が自動で立ち、削除できる', async ({ page, request }) => {
        await syncEpg(request);

        await goto(page, '/rules');
        await page.getByTestId('rule-name').fill('テストアニメ自動録画');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        await page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`).check();
        await page.getByTestId('rule-cmcut').selectOption('cut');
        await page.getByTestId('rule-submit').click();

        const rule = page.getByTestId('rule-row').first();
        await expect(rule).toContainText('テストアニメ自動録画');
        await expect(rule).toContainText('有効');
        await expect(rule.getByTestId('rule-cmcut-badge')).toContainText('CM: カット');

        // 偽Mirakurunは同じ番組名を周期的に返すので、ルール作成と同時に予約が立つ
        await goto(page, '/reservations');
        const fromRule = page.getByTestId('reservation-row').filter({ hasText: 'テストアニメ自動録画' });
        await expect(fromRule.first()).toBeVisible();

        // 無効化しても既存の予約は残る(意図せず録り逃さないため)
        await goto(page, '/rules');
        await rule.getByTestId('rule-toggle').click();
        await expect(page.getByTestId('rule-row').first()).toContainText('無効');

        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);

        // 後続に影響しないよう、このルールが作った予約は片付ける
        await goto(page, '/reservations');
        for (;;) {
            const buttons = page.getByTestId('cancel-button');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(200);
        }
    });
});
