import { expect, goto, syncEpg, test } from './helpers';

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
         * **一番後ろ**を取る。並びは放送が近い順で、偽エージェントの番組は10秒しかないため、
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
         * 状態そのものは見ない。偽エージェントの番組は10秒で始まるので、戻した直後に
         * 録画中へ進んでいることがある (「取り消し」でなくなっていることが要点)
         */
        await goto(page, '/');
        await expect(page.locator(`[data-reservation-id="${id}"]`)).toBeVisible();
        await expect(page.locator(`[data-reservation-id="${id}"]`).getByTestId('restore-button')).toHaveCount(
            0,
        );
    });

    /*
     * **実機で踏んだところ。** 消すのを `scheduled`/`conflict` に絞っていた頃は、
     * 取り消し済みのぶんがルールとの紐付けだけ外されて残っていた。それが後から
     * `scheduled` に戻ると、消したはずのルールの予約が「ルール: (削除済み)」として
     * 一覧に並ぶ (実機で 45 件)。まだ1コマも録っていないものは状態を問わず消す
     */
    test('ルールを消すと、取り消し済みのぶんも残らない', async ({ page }) => {
        await goto(page, '/');
        const row = page
            .getByTestId('reservation-row')
            .filter({ hasText: 'テストアニメ' })
            .filter({ has: page.getByTestId('cancel-button') })
            .last();
        await expect(row).toBeVisible();
        const id = await row.getAttribute('data-reservation-id');
        await row.getByTestId('cancel-button').click();

        // 取り消し済みとしては残っている
        await goto(page, '/?all=1');
        await expect(page.locator(`[data-reservation-id="${id}"]`)).toBeVisible();

        await goto(page, '/rules');
        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);

        await goto(page, '/?all=1');
        await expect(page.locator(`[data-reservation-id="${id}"]`)).toHaveCount(0);
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

    /*
     * **録れたあとも、どのルールが拾ったのかが分かる。**
     *
     * 予約の側にしか出していなかった頃は、録画一覧に要らないものが混ざっていても
     * 直す先 (どのルールの条件か) が画面から辿れなかった。予約は録り終えると
     * 一覧から消えるので、番組名からルールを推し量るしかない。
     *
     * ルールを消したあとも録画そのものは履歴として残る。紐付けだけ外れるので
     * 「(削除済み)」になる (rules の delete がそうしている)
     */
    test('録れたあとも、どのルールで録れたかが残る', async ({ page }) => {
        test.setTimeout(180_000);
        await goto(page, '/');
        /*
         * **一番前**を取る。並びは放送が近い順で、待つのはこれから録れるものなので、
         * 後ろのものを選ぶと放送そのものが数分先になる (偽の番組表は10分ぶんある)
         */
        const reservation = page
            .getByTestId('reservation-row')
            .filter({ hasText: 'テストアニメ' })
            .filter({ has: page.getByTestId('rule-name') })
            .first();
        await expect(reservation).toBeVisible();
        // 番組で辿る。同じ名前の録画は他のテストも残すので、名前では絞れない
        const programId = await reservation.getAttribute('data-program-id');

        const recording = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
        await expect(async () => {
            await goto(page, '/');
            await expect(recording).toHaveCount(1);
        }).toPass({ timeout: 120_000 });
        await expect(recording.getByTestId('rule-name')).toContainText('テストアニメ');
        // ルール名はそのまま編集への入口。予約の行と同じ形
        await expect(recording.getByTestId('rule-name').getByRole('link')).toHaveAttribute(
            'href',
            /\/rules\?edit=\d+$/,
        );

        await goto(page, '/rules');
        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);

        await goto(page, '/');
        await expect(recording.getByTestId('rule-name')).toContainText('(削除済み)');
    });
});
