import { expect, test } from '@playwright/test';
import { FUJI, MX } from '../fake/services';
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
        // 1局に絞ると行が放送順に並ぶので、十分先の番組を選べる
        await goto(page, `/guide?service=${MX.id}`);

        // 直近の番組はすぐ録画が始まってしまうので、少し先の枠を予約する
        const programId = await programIdOf(page.getByTestId('program-row').nth(5));
        // 番組が終わると行がずれるので、以降はIDで固定したロケータを使う
        const row = page.locator(`[data-testid="program-row"][data-program-id="${programId}"]`);
        await row.getByTestId('reserve-button').click();

        // 予約済みになると予約ボタンがバッジに変わる
        await expect(row).toContainText('予約済み');
        await expect(row.getByTestId('reserve-button')).toHaveCount(0);

        await goto(page, '/reservations');
        const reservation = page.locator(`[data-testid="reservation-row"][data-program-id="${programId}"]`);
        await expect(reservation).toHaveCount(1);
        await expect(reservation).toContainText('手動');
        await expect(reservation.getByTestId('reservation-state')).toHaveText('予約済み');

        await reservation.getByTestId('cancel-button').click();
        await expect(reservation).toHaveCount(0);

        // 取り消したものは「完了分も表示」でだけ見える
        await goto(page, '/reservations?all=1');
        await expect(
            page.locator(`[data-testid="reservation-row"][data-program-id="${programId}"]`),
        ).toContainText('キャンセル');
    });

    test('ルール未設定でも複数チャンネルの予約が並行して立つ', async ({ page }) => {
        await goto(page, `/guide?service=${FUJI.id}`);

        const programId = await programIdOf(page.getByTestId('program-row').nth(8));
        const row = page.locator(`[data-testid="program-row"][data-program-id="${programId}"]`);
        await row.getByTestId('reserve-button').click();
        await expect(row).toContainText('予約済み');

        await goto(page, '/reservations');
        const reservation = page.locator(`[data-testid="reservation-row"][data-program-id="${programId}"]`);
        // GRのチューナーは2本あるので、他局の予約と重なっても競合しない
        await expect(reservation.getByTestId('reservation-state')).toHaveText('予約済み');

        await reservation.getByTestId('cancel-button').click();
        await expect(reservation).toHaveCount(0);
    });
});
