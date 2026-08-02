import { BS11 } from '../fake/services';
import { expect, goto, syncEpg, test } from './helpers';

test.describe('自動予約ルール', () => {
    test('条件が空のルールは作れない', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-error')).toContainText(
            'キーワード・チャンネル・ジャンルのどれかは指定してください',
        );
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
    });

    test('キーワードルールを作ると予約が自動で立ち、削除できる', async ({ page, request }) => {
        await syncEpg(request);

        await goto(page, '/rules');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        // チャンネルは既定で畳んである
        await page.getByTestId('channel-summary').click();
        await page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`).check();
        await page.getByTestId('rule-submit').click();

        // ルール名はキーワードから付く
        const rule = page.getByTestId('rule-row').first();
        await expect(rule).toContainText('テストアニメ');
        await expect(rule).toContainText('有効');

        // 偽mirakcは同じ番組名を周期的に返すので、ルール作成と同時に予約が立つ
        await goto(page, '/');
        const fromRule = page.getByTestId('reservation-row').filter({ hasText: 'テストアニメ' });
        // ルールで立ったものは、どのルールから来たかを番組名の下に出す
        await expect(fromRule.first().getByTestId('rule-name')).toContainText('テストアニメ');
        await expect(fromRule.first()).toBeVisible();

        // 無効化しても既存の予約は残る(意図せず録り逃さないため)
        await goto(page, '/rules');
        await rule.getByTestId('rule-toggle').click();
        await expect(page.getByTestId('rule-row').first()).toContainText('無効');

        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);

        // 後続に影響しないよう、このルールが作った予約は片付ける
        await goto(page, '/');
        for (;;) {
            const buttons = page.getByTestId('cancel-button');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(200);
        }
    });
});

test.describe('キーワードを当てる範囲', () => {
    /*
     * 偽mirakc の番組は、番組名にも概要にも出てこない語を詳細に持たせてある。
     * 既定(番組名だけ)では当たらず、詳細まで広げると当たる、という差を見る。
     */
    test('既定は番組名だけで、詳細まで広げると出演者でも当たる', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/rules');

        await page.getByTestId('rule-keyword').fill('ゲスト太郎');
        await page.getByTestId('rule-preview').click();
        await expect(page.getByTestId('preview')).toContainText('0 件');

        // 詳細にチェックを入れると同じキーワードで当たる
        await page.getByTestId('rule-keyword').fill('ゲスト太郎');
        await page.getByTestId('rule-search-fields').locator('input[value="extended"]').check();
        await page.getByTestId('rule-preview').click();
        await expect(page.getByTestId('preview-row').first()).toBeVisible();
        // 選んだ範囲は結果と一緒に残る。押し直すたびに戻ると使えない
        await expect(page.getByTestId('rule-search-fields').locator('input[value="extended"]')).toBeChecked();
    });
});

test.describe('ジャンル指定', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/rules');
        for (let i = 0; i < 20; i++) {
            const buttons = page.getByTestId('rule-delete');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(100);
        }
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
    });

    test('ジャンルだけでもルールを作れる', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('genre-summary').click();
        // 偽mirakcの番組は全部「アニメ／特撮」(lv1=7)
        await page.getByTestId('rule-genres').locator('input[value="7"]').check();
        await page.getByTestId('rule-submit').click();

        // キーワードが無いときはジャンル名がルール名になる
        const rule = page.getByTestId('rule-row').first();
        await expect(rule).toContainText('アニメ／特撮');

        // ジャンルだけで予約が立つ
        await goto(page, '/');
        await expect(page.getByTestId('reservation-row').first()).toBeVisible();
    });

    test('合わないジャンルなら何も録らない', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('genre-summary').click();
        // スポーツ(lv1=1)。偽mirakcはアニメしか流さない
        await page.getByTestId('rule-genres').locator('input[value="1"]').check();
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(1);

        await goto(page, '/');
        await expect(page.getByTestId('reservation-row')).toHaveCount(0);
    });
});
