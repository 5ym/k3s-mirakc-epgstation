import { expect, test } from '@playwright/test';
import { goto, syncEpg } from './helpers';

test.describe('ダッシュボードと画面遷移', () => {
    test('EPG取得後に局・番組が反映され、全ページを開ける', async ({ page, request }) => {
        await syncEpg(request);

        await goto(page, '/');
        await expect(page.getByTestId('status')).toContainText('Mirakurun');

        // 偽Mirakurunは3局を返す。取り込めていれば「番組 / 局」の右側が3になる
        await expect(page.getByTestId('stats')).toContainText('/ 3');

        for (const [name, heading] of [
            ['nav-guide', '番組表'],
            ['nav-reservations', '予約'],
            ['nav-rules', '自動予約ルール'],
            ['nav-encodes', 'エンコード'],
            ['nav-recordings', 'ライブラリ'],
        ] as const) {
            await page.getByTestId(name).click();
            await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
        }
    });

    test('ダッシュボードのボタンからEPGを取り直せる', async ({ page }) => {
        await goto(page, '/');
        await page.getByTestId('sync-button').click();
        await expect(page.getByTestId('sync-result')).toContainText('局 3');
    });

    test('番組表がキーワードで絞り込める', async ({ page }) => {
        await goto(page, '/guide');
        await expect(page.getByTestId('program-row').first()).toBeVisible();

        await page.getByTestId('filter-keyword').fill('テストアニメ');
        await page.getByRole('button', { name: '絞り込む' }).click();
        // GETフォームは通常のページ遷移。遷移前のDOMを読まないようURLの確定を待つ
        await page.waitForURL(/[?&]q=/);

        const rows = page.getByTestId('program-row');
        await expect(rows.first()).toBeVisible();
        for (const row of await rows.all()) {
            await expect(row).toContainText('テストアニメ');
        }
    });
});
