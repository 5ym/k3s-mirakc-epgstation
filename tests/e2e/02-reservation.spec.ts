import { cellOf, expect, goto, past, setRecording, syncEpg, test, upcoming } from './helpers';

test.describe('手動予約', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('番組表から予約して、予約一覧に出て、取り消せる', async ({ page }) => {
        // グリッドは実番組の尺を前提にしていて、10秒の偽番組だとマスが潰れて押せない。
        // 地上波は30分枠にしてある
        await goto(page, '/guide?type=GR');
        const [target] = await upcoming(page);

        const cell = cellOf(page, target.programId);
        await cell.getByTestId('program-button').click();
        await page.getByTestId('detail-reserve').click();

        // 予約済みになると見た目が変わる
        await expect(cell).toContainText('予約済み');

        await goto(page, '/');
        const reservation = page.locator(
            `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
        );
        await expect(reservation).toHaveCount(1);
        // 手で入れたものには種別を出さない。ルールで立ったときだけ名前を出す
        await expect(reservation.getByTestId('rule-name')).toHaveCount(0);
        await expect(reservation.getByTestId('reservation-state')).toHaveText('予約済み');

        await reservation.getByTestId('cancel-button').click();
        await expect(reservation).toHaveCount(0);

        // 取り消したものは「完了分も表示」でだけ見える
        await goto(page, '/?all=1');
        await expect(
            page.locator(`[data-testid="reservation-row"][data-program-id="${target.programId}"]`),
        ).toContainText('キャンセル');
    });

    test('ルール未設定でも複数チャンネルの予約が並行して立つ', async ({ page }) => {
        await goto(page, '/guide?type=GR');
        const cells = await upcoming(page);

        // 同じ時間帯で局が違うものを2つ選ぶ。GRのチューナーは2本あるので、
        // 時間が丸かぶりでも競合にはならない、というのがここで見たいこと
        const first = cells[0];
        const second = cells.find((c) => c.startAt === first.startAt && c.serviceId !== first.serviceId);
        expect(second).toBeTruthy();

        for (const target of [first, second!]) {
            const cell = cellOf(page, target.programId);
            await cell.getByTestId('program-button').click();
            await page.getByTestId('detail-reserve').click();
            await expect(cell).toContainText('予約済み');
        }

        await goto(page, '/');
        for (const target of [first, second!]) {
            const reservation = page.locator(
                `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
            );
            await expect(reservation.getByTestId('reservation-state')).toHaveText('予約済み');
            await reservation.getByTestId('cancel-button').click();
            await expect(reservation).toHaveCount(0);
        }
    });
});

test.describe('予約の細かい指定', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('録画のしかたは設定画面で決めて、そこから予約に入る', async ({ page, request }) => {
        // 番組ごとの指定は置いていない。同じ選択肢が予約・ルール・設定にあると
        // 「どれで決まったのか」が分からなくなるため
        await setRecording(request, { keepOriginal: true });
        try {
            await goto(page, '/guide?type=GR');
            const [target] = await upcoming(page);

            await cellOf(page, target.programId).getByTestId('program-button').click();
            await expect(page.getByTestId('reserve-options')).toHaveCount(0);
            await page.getByTestId('detail-reserve').click();

            await goto(page, '/');
            const reservation = page.locator(
                `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
            );
            await expect(reservation).toContainText('生TSも残す');

            await reservation.getByTestId('cancel-button').click();
            await expect(reservation).toHaveCount(0);
        } finally {
            await setRecording(request);
        }
    });

    test('予約の行を押すと番組表と同じ詳細が出る', async ({ page }) => {
        await goto(page, '/guide?type=GR');
        const [target] = await upcoming(page);

        // まず番組表側での見え方を控える
        await cellOf(page, target.programId).getByTestId('program-button').click();
        const title = ((await page.getByTestId('program-detail').locator('h3').textContent()) ?? '').trim();
        const badges = (await page.getByTestId('detail-badges').locator('.badge').allTextContents()).map(
            (text) => text.trim(),
        );
        expect(badges.length).toBeGreaterThan(0);
        await page.getByTestId('detail-reserve').click();

        // 予約一覧の行からも、同じものが同じ形で出ること。
        // 一覧は番組の中身を持っていないので、EPG から引き直して出している
        await goto(page, '/');
        const reservation = page.locator(
            `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
        );
        await reservation.locator('td').first().click();

        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail.locator('h3')).toHaveText(title);
        await expect(async () => {
            const shown = (await detail.getByTestId('detail-badges').locator('.badge').allTextContents()).map(
                (text) => text.trim(),
            );
            expect(shown).toEqual(badges);
        }).toPass();

        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);

        // 行の中のボタンを押したときは詳細を出さない。出すと取消の確認が隠れる
        await reservation.getByTestId('cancel-button').click();
        await expect(reservation).toHaveCount(0);
        await expect(detail).toHaveCount(0);
    });

    test('放送が終わった番組には予約する口を出さない', async ({ page }) => {
        // 番組表には過去の番組も並んでいる。押せてしまうと、押した先で断られるだけ
        await goto(page, '/guide?type=GR');
        const done = await past(page);

        await cellOf(page, done[0].programId).getByTestId('program-button').click();
        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail.getByTestId('detail-ended')).toHaveText('放送終了');
        await expect(detail.getByTestId('detail-reserve')).toHaveCount(0);
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);

        await goto(page, '/');
        await expect(
            page.locator(`[data-testid="reservation-row"][data-program-id="${done[0].programId}"]`),
        ).toHaveCount(0);
    });
});
