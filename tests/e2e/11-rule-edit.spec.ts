import { expect, test } from '@playwright/test';
import { BS11 } from '../fake/services';
import { goto, syncEpg } from './helpers';

test.describe('ルールの編集', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/rules');
        for (let i = 0; i < 20; i++) {
            const buttons = page.getByTestId('rule-delete');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(100);
        }
    });

    test('作ったルールの条件を後から変えられる', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row').first()).toContainText('テストアニメ');

        await page.getByTestId('rule-edit').first().click();
        await page.waitForURL(/edit=/);

        // いまの内容が入っていること。空のフォームだと作り直しになってしまう
        await expect(page.getByTestId('rule-keyword')).toHaveValue('テストアニメ');

        await page.getByTestId('rule-keyword').fill('ニュース');
        await page.getByTestId('rule-ignore').fill('再放送');
        await page.getByTestId('channel-summary').click();
        await page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`).check();
        await page.getByTestId('rule-update').click();
        await page.waitForURL('**/rules');

        // 増えずに書き換わること
        await expect(page.getByTestId('rule-row')).toHaveCount(1);
        const row = page.getByTestId('rule-row').first();
        await expect(row).toContainText('ニュース');
        await expect(row).toContainText('再放送');
        await expect(row).toContainText('BS11イレブン');

        // 編集画面に入り直しても、変えた内容が入っている
        await page.getByTestId('rule-edit').first().click();
        await expect(page.getByTestId('rule-ignore')).toHaveValue('再放送');
        await expect(page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`)).toBeChecked();

        await page.getByTestId('rule-cancel-edit').click();
        await page.getByTestId('rule-delete').first().click();
        await goto(page, '/');
        for (let i = 0; i < 80; i++) {
            const buttons = page.getByTestId('cancel-button');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(80);
        }
    });
});

test.describe('ルールの作り直し', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/rules');
        for (let i = 0; i < 20; i++) {
            const buttons = page.getByTestId('rule-delete');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(100);
        }
    });

    test('同じルールを消して作り直すと、また予約が立つ', async ({ page }) => {
        // 消した予約を「取り消し」で残していた頃は、applyRules が
        // 「予約行が既にある」と見て飛ばすため、二度と予約が立たなかった
        for (const round of [1, 2]) {
            await goto(page, '/rules');
            await page.getByTestId('rule-keyword').fill('テストアニメ');
            await page.getByTestId('rule-submit').click();
            await expect(page.getByTestId('rule-row')).toHaveCount(1);

            await goto(page, '/');
            await expect(
                page.getByTestId('reservation-row').filter({ hasText: 'テストアニメ' }).first(),
                `${round} 回目`,
            ).toBeVisible();

            await goto(page, '/rules');
            await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
            await expect(page.getByTestId('rule-row')).toHaveCount(0);
        }
    });
});
