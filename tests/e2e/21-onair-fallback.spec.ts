import { expect, goto, reserveSoon, syncEpg, test } from './helpers';

/**
 * 放送の延長への追従のうち、**時間のかかるほう**。
 *
 * 20 と中身は地続きだが、ファイルの中は順番に流れるので分けてある
 * (ここだけで1分近くかかり、そのままだと全体の待ち時間を決めてしまう)。
 */
test.describe('放送の延長 (追従できない局と、延長)', () => {
    test.afterEach(async ({ request, stack }) => {
        await request.post(`${stack.agentUrl}/__control/extend?ms=0`);
        await request.post(`${stack.agentUrl}/__control/onair?silent=0`);
    });

    test('EIT[p/f] が来ない局でも、番組表の時刻どおりに録れる', async ({ page, request, stack }) => {
        test.setTimeout(120_000);
        /*
         * いま流れている番組を知らせてこない局。**延長には追従できない**が、
         * 録画そのものは番組表の時刻で回るので落としてはいけない。
         *
         * mirakc の頃はここが「番組単位で開いても1バイトも来ない」状況で、
         * サービス単位へ切り替える必要があった。物理チャンネルを丸ごと開く
         * いまは、そもそも切り替える先が無い
         */
        await request.post(`${stack.agentUrl}/__control/onair?silent=1`);
        await syncEpg(request);
        const programId = await reserveSoon(page, request, 'BS');

        // この予約から生まれた録画だけを見る (前のテストの残りと混ざらないように)
        for (let i = 0; i < 120; i++) {
            await goto(page, '/?all=1');
            const row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
            if ((await row.count()) > 0) {
                await expect(row.first().getByTestId('recording-state')).not.toHaveText('失敗');
                return;
            }
            await page.waitForTimeout(500);
        }
        throw new Error('録画が残らなかった');
    });

    test('延びたら録画の終わりも後ろへ動く', async ({ page, request, stack }) => {
        test.setTimeout(120_000);
        await syncEpg(request);
        await reserveSoon(page, request, 'BS');

        const recording = page.getByTestId('reservation-row').filter({ hasText: '録画中' }).first();
        for (let i = 0; i < 60; i++) {
            await goto(page, '/');
            if ((await recording.count()) > 0) break;
            await page.waitForTimeout(500);
        }
        await expect(recording).toBeVisible();
        const before = ((await recording.textContent()) ?? '').trim();

        // 放送が10分押した状態にする
        await request.post(`${stack.agentUrl}/__control/extend?ms=${10 * 60 * 1000}`);

        // 予約の終了時刻が動くまで待つ。動かないと元の時刻で切られてしまう
        let after = before;
        for (let i = 0; i < 60; i++) {
            await goto(page, '/');
            const row = page.getByTestId('reservation-row').filter({ hasText: '録画中' }).first();
            if ((await row.count()) > 0) {
                after = ((await row.textContent()) ?? '').trim();
                if (after !== before) break;
            }
            await page.waitForTimeout(500);
        }
        expect(after, '終了時刻が延びていない').not.toBe(before);
    });
});
