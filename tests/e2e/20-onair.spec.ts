import { expect, test } from '@playwright/test';
import { MIRAKC_URL } from '../../playwright.config';
import { goto, reserveSoon, syncEpg } from './helpers';

/**
 * 放送の延長への追従。
 *
 * denpa は番組単位のストリームで録る。切れ目を決めるのは番組表の時刻ではなく
 * 実際の放送 (EIT[p/f]) で、mirakc 側がそれを見て番組情報を書き換える。
 * denpa はそれを読んで、止める時刻を後ろへずらす。
 */
test.describe('放送の延長', () => {
    test.afterEach(async ({ request }) => {
        await request.post(`${MIRAKC_URL}/__control/extend?ms=0`);
        await request.post(`${MIRAKC_URL}/__control/onair?silent=0`);
    });

    test('番組単位で開き、mirakc に追従役を立てさせる', async ({ page, request }) => {
        test.setTimeout(90_000);
        await syncEpg(request);
        // BS は1番組10秒にしてある。すぐ録画が始まる (地上波は30分枠)
        const programId = await reserveSoon(page, request, 'BS');

        // 録画が始まるまで待つ
        const row = page.getByTestId('reservation-row').filter({ hasText: '録画中' });
        for (let i = 0; i < 60; i++) {
            await goto(page, '/');
            if ((await row.count()) > 0) break;
            await page.waitForTimeout(500);
        }
        await expect(row.first()).toBeVisible();

        /*
         * 追従役はチューナーを増やさない。番組単位のストリームに相乗りするだけで、
         * その合図が User-Agent。立っていないと延長を読めない
         */
        const tracked = await (await request.get(`${MIRAKC_URL}/__control/onair`)).json();
        expect(tracked.tracked).toContain(Number(programId));
    });

    test('番組が始まらなければサービス単位に切り替えて録る', async ({ page, request }) => {
        test.setTimeout(120_000);
        /*
         * 番組単位で開いても1バイトも来ない状況。EIT[p/f] が来ない局に当たると
         * こうなる。切り替えずに待ち続けると、その番組は丸ごと録れない
         */
        await request.post(`${MIRAKC_URL}/__control/onair?silent=1`);
        await syncEpg(request);
        const programId = await reserveSoon(page, request, 'BS');

        // この予約から生まれた録画だけを見る (前のテストの残りと混ざらないように)
        for (let i = 0; i < 120; i++) {
            await goto(page, '/?all=1');
            const row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
            if ((await row.count()) > 0) {
                // 切り替えられていれば中身がある。失敗していたら切り替わっていない
                await expect(row.first().getByTestId('recording-state')).not.toHaveText('失敗');
                return;
            }
            await page.waitForTimeout(500);
        }
        throw new Error('切り替えても録画が残らなかった');
    });

    test('延びたら録画の終わりも後ろへ動く', async ({ page, request }) => {
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
        await request.post(`${MIRAKC_URL}/__control/extend?ms=${10 * 60 * 1000}`);

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
