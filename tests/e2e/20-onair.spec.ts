import { expect, goto, reserveSoon, syncEpg, test } from './helpers';

/**
 * 放送の延長への追従。
 *
 * denpa は番組単位のストリームで録る。切れ目を決めるのは番組表の時刻ではなく
 * 実際の放送 (EIT[p/f]) で、mirakc 側がそれを見て番組情報を書き換える。
 * denpa はそれを読んで、止める時刻を後ろへずらす。
 */
test.describe('放送の延長', () => {
    test.afterEach(async ({ request, stack }) => {
        await request.post(`${stack.mirakcUrl}/__control/extend?ms=0`);
        await request.post(`${stack.mirakcUrl}/__control/onair?silent=0`);
    });

    test('mirakc の知らせを聞いている', async ({ request, stack }) => {
        /*
         * 番組表の取り直しも延長への追従も、これを聞いて動く。
         * 繋がっていないと定期実行の保険だけになり、気付くのが分単位まで遅れる
         */
        const status = await (await request.get(`${stack.mirakcUrl}/__control/listeners`)).json();
        expect(status.listeners, 'denpa が /events に繋いでいない').toBeGreaterThan(0);
    });

    test('番組単位で開き、mirakc に追従役を立てさせる', async ({ page, request, stack }) => {
        test.setTimeout(90_000);
        await syncEpg(request);
        // BS は1番組10秒にしてある。すぐ録画が始まる (地上波は30分枠)
        // 1つ先を狙う。すぐ次のものだと、予約を投げ終える前に始まってしまうことがある
        const programId = await reserveSoon(page, request, 'BS', 1);

        // **その予約が**録画中になるまで待つ。番組の切れ目に居合わせると、
        // 別の予約が録画中になっているだけのことがある
        const row = page.locator(`[data-testid="reservation-row"][data-program-id="${programId}"]`);
        await expect(async () => {
            await goto(page, '/');
            await expect(row.getByTestId('reservation-state')).toHaveText('録画中');
        }).toPass({ timeout: 60_000 });

        /*
         * 追従役はチューナーを増やさない。番組単位のストリームに相乗りするだけで、
         * その合図が User-Agent。立っていないと延長を読めない
         */
        await expect(async () => {
            const tracked = await (await request.get(`${stack.mirakcUrl}/__control/onair`)).json();
            expect(tracked.tracked).toContain(Number(programId));
        }).toPass({ timeout: 30_000 });
    });
});
