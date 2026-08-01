import { expect, test } from '@playwright/test';
import { cellOf, goto, reserveSoon, syncEpg, upcoming } from './helpers';

/**
 * 画面の反応の確かめ。
 * 「押したのに何も起きない」「リロードすると変わっている」の類は
 * 見た目の問題に見えて実際には状態の取り扱いの誤りなので、ここで固定する。
 */
test.describe('操作したときの反応', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        // 前のテストが残した予約やルールを片付ける。件数で判定するため
        await goto(page, '/rules');
        for (let i = 0; i < 20; i++) {
            const buttons = page.getByTestId('rule-delete');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(100);
        }
        await goto(page, '/reservations');
        for (let i = 0; i < 80; i++) {
            const buttons = page.getByTestId('cancel-button');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(80);
        }
        // 片付け切れていないと件数の検証が意味を失うので、ここで落とす
        await expect(page.getByTestId('reservation-row')).toHaveCount(0);
    });

    test('番組表で予約すると詳細が閉じ、予約済みになる', async ({ page }) => {
        await goto(page, '/guide?type=GR');

        const [target] = await upcoming(page);
        const block = cellOf(page, target.programId);
        await block.getByTestId('program-button').click();

        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();

        // EPG の符号はそのままでは読めないので、言葉に直して出す
        await expect(detail.getByTestId('detail-genre')).toHaveText('アニメ／特撮 > 国内アニメ');
        await expect(detail.getByTestId('detail-video')).toHaveText('1080i MPEG-2');
        await expect(detail.getByTestId('detail-audio')).toHaveText('ステレオ (日本語)');
        // どの局のものかは詳細だけ見ても分かるようにする。
        // 先頭に来るのがどちらの局かは時刻次第なので、地上波のどちらかであればよい
        await expect(detail).toContainText(/TOKYO MX|フジテレビ/);

        await detail.getByTestId('detail-reserve').click();

        // 押したら閉じる。開いたままだと予約できたのか分からない
        await expect(detail).toHaveCount(0);

        await expect(block).toContainText('予約済み');
    });

    test('ダッシュボードで取り消すと、その場で一覧から消える', async ({ page, request }) => {
        await reserveSoon(page, request, 'GR', 6);

        await goto(page, '/reservations');
        const rows = page.getByTestId('reservation-row');
        await expect(rows).toHaveCount(1);

        await page.getByTestId('cancel-button').first().click();
        // リロードせずに反映されること
        await expect(rows).toHaveCount(0);
    });

    test('ルールを消すと、そのルールが作った予約も消える', async ({ page }) => {
        // ルールを作ると、条件に合う番組の予約がその場で立つ
        await goto(page, '/rules');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(1);

        await goto(page, '/reservations');
        await expect(page.getByTestId('reservation-row').first()).toBeVisible();
        const before = await page.getByTestId('reservation-row').count();
        expect(before).toBeGreaterThan(0);

        await goto(page, '/rules');
        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);

        // ルールが無くなったのに予約だけ残ると、止めたつもりが録れ続ける
        await goto(page, '/reservations');
        await expect(page.getByTestId('reservation-row')).toHaveCount(0);
    });
});
