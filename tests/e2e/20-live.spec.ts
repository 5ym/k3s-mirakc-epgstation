import { expect, goto, syncEpg, test } from './helpers';

/**
 * ライブ視聴の第1段階 ([docs/stream.md](../../docs/stream.md) §4 の1番目)。
 *
 * **絵が出るところまでは見ない。** E2E の ffmpeg は偽物で、流れてくるのも
 * 本物の TS ではないため、MSE が受け取れる fMP4 にはならない。ここで固定するのは
 * その手前まで — **札を取り、WebSocket が繋がり、チューナーを掴み、選んだ局が
 * 「いま映しているもの」になる**という経路。ここが通っていれば、あとは
 * 焼いたものが正しいかどうかの話になる。
 */
test.describe('ライブ視聴', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('ヘッダーの「ライブ」から開ける', async ({ page }) => {
        await goto(page, '/');
        await page.getByTestId('nav-live').click();
        await expect(page).toHaveURL(/\/live$/);
        await expect(page.getByTestId('live')).toBeVisible();
    });

    test('右にチャンネルが並ぶ', async ({ page }) => {
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        await expect(channels.first()).toBeVisible();
        expect(await channels.count()).toBeGreaterThan(1);
        // 番組表と同じ並び。地上波はリモコン番号順で先頭に来る
        await expect(channels.first()).toHaveAttribute('data-channel', /^GR\//);
    });

    /*
     * **映像を見ながら選ぶ画面なので、ページごと動かさない。** 動くと絵が
     * 画面から出ていく。動くのは右の一覧だけ
     */
    test('広い画面ではページごとスクロールしない', async ({ page }) => {
        // **低めの画面で見る。** 高いと直す前の作りでも収まってしまい、判別できない
        await page.setViewportSize({ width: 1440, height: 700 });
        await goto(page, '/live');
        await expect(page.getByTestId('live-channel').first()).toBeVisible();

        const doc = await page.evaluate(() => ({
            scrollH: document.documentElement.scrollHeight,
            clientH: document.documentElement.clientHeight,
        }));
        expect(doc.scrollH).toBeLessThanOrEqual(doc.clientH + 1);
    });

    /*
     * **一覧は残りの高さをぜんぶ使う。** 決め打ちで切っていた頃は、画面の下に
     * 余白があるのに一覧のほうが先に終わっていた
     */
    test('チャンネル一覧は表示領域いっぱいまで伸びる', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 700 });
        await goto(page, '/live');
        const list = page.getByTestId('live-channels');
        await expect(list).toBeVisible();

        const box = (await list.boundingBox())!;
        const viewport = page.viewportSize()!;
        // 下端まで、余白ぶん (24px) 以上は空けない
        expect(viewport.height - (box.y + box.height)).toBeLessThanOrEqual(28);
    });

    /*
     * **既定で黙らせない。** `muted` を書き付けていた頃は、開いても永久に
     * 無音だった (備え付けの操作で外すまで誰も気付けない)。黙るのは
     * 自動再生を断られたときだけで、そのときは押せる場所を出す
     */
    test('音を止めた状態では始めない', async ({ page }) => {
        await goto(page, '/live');
        await expect(page.getByTestId('live-video')).toBeVisible();
        const muted = await page.getByTestId('live-video').evaluate((v) => (v as HTMLVideoElement).muted);
        expect(muted).toBe(false);
    });

    /*
     * **繋がったことは、掴んだチューナーで分かる。** 画面に絵が出ないので、
     * 「押したら何かが起きた」をこちらで見る。用途に `live` と出るのは
     * ライブ視聴だけなので、これが出ていれば経路は通っている
     */
    test('局を選ぶとチューナーを掴む', async ({ page }) => {
        await goto(page, '/live');
        const target = page.getByTestId('live-channel').first();
        const channel = await target.getAttribute('data-channel');
        await target.click();

        // 選んだ局が「いま映しているもの」になる
        await expect(page.getByTestId('live-title')).toBeVisible();

        await goto(page, '/tuners');
        await expect(page.getByText(/ライブ/).first()).toBeVisible();
        expect(channel).not.toBeNull();
    });

    /*
     * **前回見ていたチャンネルで開く。** テレビを点けたときと同じ振る舞いで、
     * 毎回いちばん上の局から始まると、いつも選び直すことになる
     */
    test('開き直すと、前回見ていた局から始まる', async ({ page }) => {
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        // 先頭以外を選ぶ。先頭だと「覚えている」のか「既定」なのか見分けが付かない
        const second = channels.nth(1);
        const picked = await second.getAttribute('data-channel');
        await second.click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await goto(page, '/live');
        // 覚えていた局が選ばれた状態で開く
        await expect(page.locator(`[data-testid="live-channel"][data-channel="${picked}"]`)).toHaveClass(
            /bg-base-200/,
        );
    });

    /*
     * **札は使い捨て。** URL は履歴にもログにも残るので、拾われても二度目は
     * 通らない。ここが緩むと、チューナーを掴む口が素通しになる
     */
    test('札なしでは WebSocket に繋げない', async ({ page }) => {
        await goto(page, '/live');
        const status = await page.evaluate(
            () =>
                new Promise<string>((resolve) => {
                    const ws = new WebSocket(
                        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live/socket`,
                    );
                    ws.onopen = () => resolve('開いた');
                    ws.onerror = () => resolve('断られた');
                    ws.onclose = () => resolve('断られた');
                    setTimeout(() => resolve('無反応'), 3000);
                }),
        );
        expect(status).toBe('断られた');
    });
});
