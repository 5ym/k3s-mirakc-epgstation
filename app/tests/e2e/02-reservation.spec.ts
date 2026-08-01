import { expect, test } from '@playwright/test';
import { cellOf, goto, syncEpg, upcoming } from './helpers';

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

        await goto(page, '/reservations');
        const reservation = page.locator(
            `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
        );
        await expect(reservation).toHaveCount(1);
        await expect(reservation).toContainText('手動');
        await expect(reservation.getByTestId('reservation-state')).toHaveText('予約済み');

        await reservation.getByTestId('cancel-button').click();
        await expect(reservation).toHaveCount(0);

        // 取り消したものは「完了分も表示」でだけ見える
        await goto(page, '/reservations?all=1');
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

        await goto(page, '/reservations');
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

    test('この番組だけ録画のしかたを変えられる', async ({ page }) => {
        await goto(page, '/guide?type=GR');
        const [target] = await upcoming(page);

        await cellOf(page, target.programId).getByTestId('program-button').click();
        // 既定のままでいいことがほとんどなので畳んである
        await expect(page.getByTestId('reserve-options')).not.toBeVisible();
        await page.getByTestId('reserve-options-summary').click();

        await page.getByTestId('reserve-codec').selectOption('h264');
        await page.getByTestId('reserve-cmcut').selectOption('cut');
        await page.getByTestId('reserve-keep').check();
        await page.getByTestId('detail-reserve').click();

        await goto(page, '/reservations');
        const reservation = page.locator(
            `[data-testid="reservation-row"][data-program-id="${target.programId}"]`,
        );
        await expect(reservation).toContainText('H264');
        await expect(reservation).toContainText('カット');

        await reservation.getByTestId('cancel-button').click();
        await expect(reservation).toHaveCount(0);
    });

    test('放送が終わった番組は予約できない', async ({ page }) => {
        // 番組表には過去の番組も並んでいる。予約できてしまうと、
        // 録れないものが予約一覧に残り続ける
        await goto(page, '/guide?type=GR');
        const past = await page.getByTestId('grid-program').evaluateAll((nodes) =>
            nodes
                .map((node) => ({
                    id: node.getAttribute('data-program-id') ?? '',
                    at: Number(node.getAttribute('data-start-at')),
                }))
                .filter((c) => c.at < Date.now() - 60 * 60 * 1000),
        );
        expect(past.length).toBeGreaterThan(0);

        await cellOf(page, past[0].id).getByTestId('program-button').click();
        await page.getByTestId('detail-reserve').click();
        await expect(page.getByTestId('guide-error')).toContainText('放送が終わっています');

        await goto(page, '/reservations');
        await expect(
            page.locator(`[data-testid="reservation-row"][data-program-id="${past[0].id}"]`),
        ).toHaveCount(0);
    });
});
