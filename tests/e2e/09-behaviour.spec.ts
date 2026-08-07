import {
    cancelAllReservations,
    cellOf,
    clearRules,
    expect,
    goto,
    reserveSoon,
    syncEpg,
    test,
    upcoming,
} from './helpers';

/**
 * 画面の反応の確かめ。
 * 「押したのに何も起きない」「リロードすると変わっている」の類は
 * 見た目の問題に見えて実際には状態の取り扱いの誤りなので、ここで固定する。
 */
test.describe('操作したときの反応', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        // 前のテストが残した予約やルールを片付ける。件数で判定するため
        await clearRules(page);
        await cancelAllReservations(page);
    });

    test('番組表で予約すると詳細が閉じ、予約済みになる', async ({ page }) => {
        await goto(page, '/guide?type=GR');

        const [target] = await upcoming(page);
        const block = cellOf(page, target.programId);
        await block.getByTestId('program-button').click();

        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();

        /*
         * EPG の符号はそのままでは読めないので、言葉に直して出す。
         *
         * **同じ分類が2つ来ても1つにまとめる。** 偽の放送は本物と同じく
         * `[アニメ, 拡張, 拡張]` を積んである (0xE は分類ではなく局が自分で決めた
         * 符号を載せる枠なので、同じものが並ぶ)。札の字を一覧の目印にしていた頃は、
         * **同じ札が2つあると Svelte が落ちて詳細が開かなかった**
         * (実機の高校野球中継。押しても何も起きない出方をする)
         */
        await expect(detail.getByTestId('detail-genre')).toHaveCount(2);
        await expect(detail.getByTestId('detail-genre').first()).toHaveText('アニメ／特撮 > 国内アニメ');
        await expect(detail.getByTestId('detail-genre').nth(1)).toHaveText('拡張');
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

    test('番組表の時刻は縦横どちらへスクロールしても左に残る', async ({ page }) => {
        // 24時間ぶんを1画面には出せないので、どこを見ていても時刻が分かる必要がある。
        // 横は列ごと、縦は数字を1時間の枠の中で下ろして追従させている
        await page.setViewportSize({ width: 900, height: 700 });
        await goto(page, '/guide?type=GR');

        const grid = page.getByTestId('guide-grid');
        const hours = grid.locator('div[style^="grid-column: 1;"] > span.sticky');
        const frame = (await grid.boundingBox())!;

        for (const top of [0, 400, 900]) {
            await grid.evaluate((el, t) => {
                el.scrollTop = t;
                // 横に流しても時刻の列は左に残る
                el.scrollLeft = 300;
            }, top);
            // 画面の上端付近に、いま見ているところの時刻がちょうど1つ出ていること
            const shown: string[] = [];
            for (let i = 0; i < (await hours.count()); i++) {
                const box = await hours.nth(i).boundingBox();
                if (box === null) continue;
                if (box.y >= frame.y - 1 && box.y < frame.y + 60 && box.x < frame.x + 60) {
                    shown.push((await hours.nth(i).textContent())?.trim() ?? '');
                }
            }
            expect(shown).toHaveLength(1);
        }
    });

    test('番組表は列の合計ぶんの幅を持つ', async ({ page }) => {
        /*
         * 時刻の列が横に付いてこられるのは、外側の枠の中にいる間だけ。
         * 枠を画面の幅のままにして中身をはみ出させていた頃は、
         * 「画面の幅 − 時刻の列」ぶんスクロールしたところで置いていかれていた
         * (390px の端末で302pxから先)。枠を列の合計まで広げておけば端まで残る
         */
        await page.setViewportSize({ width: 320, height: 700 });
        await goto(page, '/guide?type=GR');

        const grid = page.getByTestId('guide-grid');
        const size = await grid.evaluate((el) => ({
            inner: Math.round(el.querySelector('[data-testid="guide-rows"]')!.getBoundingClientRect().width),
            scroll: el.scrollWidth,
        }));
        expect(size.inner).toBe(size.scroll);
    });

    /*
     * **番組の詳細は、狭い画面でも画面の中に収まる。**
     *
     * daisyUI の既定は外枠が `inset: 0`、中身が `max-height: 100vh` で、どちらも
     * **アドレスバーが引っ込んだときの高さ**を指す。スマホでバーが出ていると
     * 中身が画面より高くなり、外枠の `overflow: clip` に上下とも切り落とされて
     * **題名も閉じるボタンも見えなくなる** (実機の Android Chrome)。
     *
     * 直したのは `dvh` (いま見えている高さ) と、上下の余白。ここで確かめられるのは
     * **余白のほう** — Playwright には引っ込むバーが無いので `dvh` と `vh` は同じ値
     * になる。余白が無いと、バーの出入りがそのまま切り落としになる。
     *
     * **画面は思い切り低くする。** 偽の放送は説明文が短いので、普通の高さだと
     * 中身が収まってしまい、直す前でも通ってしまう (実際に一度そうなった)
     */
    test('番組の詳細は、狭くて低い画面でも枠に収まる', async ({ page }) => {
        const view = { width: 390, height: 380 };
        await page.setViewportSize(view);
        await goto(page, '/guide?type=GR');

        // 説明がいちばん長いものを開く。短いものだと収まって当たり前になる
        const cells = await page.getByTestId('grid-program').evaluateAll((nodes) =>
            nodes.map((node) => ({
                id: node.getAttribute('data-program-id') ?? '',
                length: (node.textContent ?? '').length,
            })),
        );
        const target = cells.sort((a, b) => b.length - a.length)[0];
        await cellOf(page, target.id).getByTestId('program-button').click();

        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        const box = (await detail.locator('> div').first().boundingBox())!;

        expect(box.y, '上が画面に貼り付いている (バーが出ると切れる)').toBeGreaterThanOrEqual(8);
        expect(box.y + box.height, '下が画面からはみ出している').toBeLessThanOrEqual(view.height - 8);
        // 題名は箱の中にある。中身が長くても、頭から読める
        const title = (await detail.locator('h3').boundingBox())!;
        expect(title.y).toBeGreaterThanOrEqual(box.y);
    });

    test('放送波を切り替えると横位置が先頭に戻る', async ({ page }) => {
        // 局の並びは放送波ごとに別物なので、前の位置から始まると左端の局が隠れる
        await page.setViewportSize({ width: 320, height: 700 });
        await goto(page, '/guide?type=GR');

        const grid = page.getByTestId('guide-grid');
        await grid.evaluate((el) => {
            el.scrollLeft = el.scrollWidth;
        });
        expect(await grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

        await page.getByTestId('type-BS').click();
        await expect(page.getByTestId('type-BS')).toHaveClass(/btn-active/);
        await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBe(0);
    });

    test('ダッシュボードで取り消すと、その場で一覧から消える', async ({ page, request }) => {
        await reserveSoon(page, request, 'GR', 6);

        await goto(page, '/');
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

        await goto(page, '/');
        await expect(page.getByTestId('reservation-row').first()).toBeVisible();
        const before = await page.getByTestId('reservation-row').count();
        expect(before).toBeGreaterThan(0);

        await goto(page, '/rules');
        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);

        // ルールが無くなったのに予約だけ残ると、止めたつもりが録れ続ける
        await goto(page, '/');
        await expect(page.getByTestId('reservation-row')).toHaveCount(0);
    });
});
