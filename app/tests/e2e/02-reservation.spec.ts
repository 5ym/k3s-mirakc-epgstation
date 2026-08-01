import { expect, test } from '@playwright/test';
import { goto, syncEpg } from './helpers';

/** 番組表の行から番組IDを取り出す。番組名は使い回されるので同定にはIDを使う */
async function programIdOf(row: import('@playwright/test').Locator): Promise<string> {
    const id = await row.getAttribute('data-program-id');
    expect(id).toBeTruthy();
    return id!;
}

test.describe('手動予約', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('番組表から予約して、予約一覧に出て、取り消せる', async ({ page }) => {
        // 局名で検索すると、その局の番組だけが放送順に並ぶ。
        // グリッドは実番組の尺を前提にしていて、10秒の偽番組だとマスが潰れて押せない
        await goto(page, '/guide?q=TOKYO+MX');
        const programId = await programIdOf(page.getByTestId('program-row').nth(5));
        // 番組が終わると並びがずれるので、以降はIDで固定したロケータを使う
        const row = page.locator(`[data-testid="program-row"][data-program-id="${programId}"]`);
        await row.getByTestId('reserve-button').click();

        // 予約済みになると押せるブロックから表示だけのブロックに変わる
        await expect(row).toContainText('予約済み');
        await expect(row.getByTestId('reserve-button')).toHaveCount(0);

        await goto(page, '/');
        const reservation = page.locator(`[data-testid="reservation-row"][data-program-id="${programId}"]`);
        await expect(reservation).toHaveCount(1);
        await expect(reservation).toContainText('手動');
        await expect(reservation.getByTestId('reservation-state')).toHaveText('予約済み');

        await reservation.getByTestId('cancel-button').click();
        await expect(reservation).toHaveCount(0);

        // 取り消したものは「完了分も表示」でだけ見える
        await goto(page, '/?all=1');
        await expect(
            page.locator(`[data-testid="reservation-row"][data-program-id="${programId}"]`),
        ).toContainText('キャンセル');
    });

    test('ルール未設定でも複数チャンネルの予約が並行して立つ', async ({ page }) => {
        await goto(page, '/guide?q=フジテレビ');

        const programId = await programIdOf(page.getByTestId('program-row').nth(8));
        const row = page.locator(`[data-testid="program-row"][data-program-id="${programId}"]`);
        await row.getByTestId('reserve-button').click();
        await expect(row).toContainText('予約済み');

        await goto(page, '/');
        const reservation = page.locator(`[data-testid="reservation-row"][data-program-id="${programId}"]`);
        // GRのチューナーは2本あるので、他局の予約と重なっても競合しない
        await expect(reservation.getByTestId('reservation-state')).toHaveText('予約済み');

        await reservation.getByTestId('cancel-button').click();
        await expect(reservation).toHaveCount(0);
    });
});
