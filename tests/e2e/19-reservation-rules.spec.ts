import { expect, test } from '@playwright/test';
import { goto, syncEpg } from './helpers';

/**
 * ルールで立った予約まわり。
 *
 * ルールが作った予約を手で取り消すと、以後ルールは作り直さない
 * (同じ番組を二度と勝手に立てないため)。気が変わったときの戻し方と、
 * ルールそのものへ辿る道をここで見る。
 */
test.describe('ルールで立った予約', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/rules');
        // 前のテストが残したルールを片付ける
        for (let i = 0; i < 20; i++) {
            const rows = page.getByTestId('rule-row');
            if ((await rows.count()) === 0) break;
            await rows.first().getByTestId('rule-delete').click();
            await page.waitForTimeout(100);
        }
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row').first()).toBeVisible();
    });

    test.afterEach(async ({ page }) => {
        await goto(page, '/rules');
        for (let i = 0; i < 20; i++) {
            const rows = page.getByTestId('rule-row');
            if ((await rows.count()) === 0) break;
            await rows.first().getByTestId('rule-delete').click();
            await page.waitForTimeout(100);
        }
    });

    test('取り消したあと戻せる', async ({ page }) => {
        await goto(page, '/');
        /*
         * 先に走ったテストが残した予約と混ざらないよう、いま立っているものから選ぶ。
         *
         * **一番後ろ**を取る。並びは放送が近い順で、偽mirakcの番組は10秒しかないため、
         * 先頭のものは取り消して開き直す間に放送が終わってしまう。終わった予約は
         * 戻しても意味が無いので、戻すボタン自体が出ない
         */
        const row = page
            .getByTestId('reservation-row')
            .filter({ hasText: 'テストアニメ' })
            .filter({ has: page.getByTestId('cancel-button') })
            .last();
        await expect(row).toBeVisible();
        const id = await row.getAttribute('data-reservation-id');

        await row.getByTestId('cancel-button').click();
        // 進行中の一覧からは消える
        await expect(page.locator(`[data-reservation-id="${id}"]`)).toHaveCount(0);

        // ルールは作り直さないので、戻せるのはここだけ。
        // 状態の表示そのものは見ない (番組が始まっていると録画中を経由する)
        await goto(page, '/?all=1');
        const canceled = page.locator(`[data-reservation-id="${id}"]`);
        await expect(canceled.getByTestId('restore-button')).toBeVisible();
        await canceled.getByTestId('restore-button').click();

        /*
         * 進行中の一覧に戻ってくれば戻せている。
         * 状態そのものは見ない。偽mirakcの番組は10秒で始まるので、戻した直後に
         * 録画中へ進んでいることがある (「取り消し」でなくなっていることが要点)
         */
        await goto(page, '/');
        await expect(page.locator(`[data-reservation-id="${id}"]`)).toBeVisible();
        await expect(page.locator(`[data-reservation-id="${id}"]`).getByTestId('restore-button')).toHaveCount(
            0,
        );
    });

    test('ルール名からそのルールの編集に飛べる', async ({ page }) => {
        await goto(page, '/');
        const row = page
            .getByTestId('reservation-row')
            .filter({ hasText: 'テストアニメ' })
            .filter({ has: page.getByTestId('rule-name') })
            .first();
        // 行にボタンを足すと窮屈になるので、出しているルール名をそのまま入口にする
        await row.getByTestId('rule-name').getByRole('link').click();

        await expect(page.getByRole('heading', { level: 2 }).first()).toContainText('ルールを編集');
        await expect(page.getByTestId('rule-keyword')).toHaveValue('テストアニメ');
    });
});
