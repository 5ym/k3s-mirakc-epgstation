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

    /**
     * 録画のしかたは**設定画面ひとつ**で決める。
     *
     * 番組ごとの指定は置いていないし、**予約にも写さない。** 写していた頃は
     * 予約を立てた時点の値で固まり、設定を変えても直らなかった (実機で、
     * 「生TSも残す」を ON にしたのに既に立っていた予約24本が OFF のままだった)。
     * 実際に読むのは**焼くとき** (encoder.ts)。
     */
    test('録画のしかたは設定画面だけで決める。番組ごとの指定は無い', async ({ page, request }) => {
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
            await expect(reservation).toHaveCount(1);
            // 予約の行に焼き方の札は出さない。焼くときの設定で決まるので、
            // 立てた時点の値を出すと設定を変えたときに嘘になる
            await expect(reservation).not.toContainText('生TSも残す');

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
        await reservation.getByTestId('row-body').click();

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

/**
 * **押したつもりが「掴んで動かした」になっていた。**
 *
 * 番組表は掴んで動かせる (`dragScroll`)。動かしたあとのクリックで番組を開いては
 * 困るので、動いていたら食う作りにしてある。その敷居が 5px しかなく、しかも指と
 * ペンにも掛かっていたため、**スマホでマスを押しても詳細が出なかった** (実機)。
 * 指は押しただけで数px ずれる。
 *
 * 指とペンはブラウザに任せ (こちらが動かすと二重に動く)、マウスの敷居も広げてある。
 */
test.describe('番組表のマスを押す', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('少しずれても開く。掴んで動かしたときだけ開かない', async ({ page }) => {
        await goto(page, '/guide?type=GR');
        const [target] = await upcoming(page);
        const cell = cellOf(page, target.programId);
        /*
         * **見えるところまで送っておく。** 番組表は 4:00 始まりなので、4時台に
         * 走らせると「これから始まる番組」がグリッドの先頭にあり、真ん中を
         * 押したつもりが貼り付いた見出しに当たっていた (時計次第で落ちていた)
         */
        await cell.scrollIntoViewIfNeeded();
        const box = (await cell.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const detail = page.getByTestId('program-detail');

        // 押した拍子に少しずれた。開くのが正しい (直す前は 6px で開かなかった)
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 6, y);
        await page.mouse.up();
        await expect(detail).toBeVisible();
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);

        /*
         * はっきり掴んで動かしたときは開かない (動かした先の番組が開いてしまう)。
         *
         * **送る向きは余地のあるほうへ。** 番組表は 4:00 から翌 4:00 までの帯なので、
         * 深夜に走らせると**もう下端まで送られていて、それ以上は動かない** —
         * 上へ送ると決め打っていた頃は 01:37 に落ちた (実際に CI で落ちた)。
         * マウスを上へ動かすと中身は下へ送られる (`scrollTop` が増える)
         */
        const grid = page.getByTestId('guide-grid');
        const room = await grid.evaluate((el) => ({
            top: el.scrollTop,
            rest: el.scrollHeight - el.clientHeight - el.scrollTop,
        }));
        // 下へ送る余地があるなら上へ動かす。無ければ逆へ
        const step = room.rest > 120 ? -20 : 20;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) await page.mouse.move(x, y + i * step);
        await page.mouse.up();
        await expect(detail).toHaveCount(0);
        const after = await grid.evaluate((el) => el.scrollTop);
        if (step < 0) expect(after, '掴んで下へ送れていない').toBeGreaterThan(room.top);
        else expect(after, '掴んで上へ送れていない').toBeLessThan(room.top);
    });

    /*
     * **指はブラウザに任せる。** これが実機で出ていたほう。
     *
     * 押しただけのつもりでも指は数px ずれるので、掴んで動かす仕掛けが
     * タップを食っていた。`touchscreen.tap` はぴたりと押してしまい
     * (ずれないので古い版でも通る)、ずれを作れないので、触った印を自分で流す。
     */
    test('指が少しずれても、タップを食わない', async ({ page }) => {
        await goto(page, '/guide?type=GR');
        const [target] = await upcoming(page);
        const cell = cellOf(page, target.programId);
        // 上と同じ理由 (4時台は「これから始まる番組」が見出しの下に隠れる)
        await cell.scrollIntoViewIfNeeded();
        const box = (await cell.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };

        await page.evaluate(
            ([x, y]) => {
                const at = (cx: number, cy: number) => ({
                    pointerId: 1,
                    pointerType: 'touch',
                    isPrimary: true,
                    bubbles: true,
                    cancelable: true,
                    clientX: cx,
                    clientY: cy,
                });
                const target = document.elementFromPoint(x, y);
                if (target === null) throw new Error('マスがそこに無い');
                target.dispatchEvent(new PointerEvent('pointerdown', at(x, y)));
                target.dispatchEvent(new PointerEvent('pointermove', at(x + 6, y)));
                target.dispatchEvent(new PointerEvent('pointerup', at(x + 6, y)));
                (target as HTMLElement).closest('button')?.click();
            },
            [box.x + box.width / 2, box.y + box.height / 2],
        );

        await expect(page.getByTestId('program-detail')).toBeVisible();
    });
});
