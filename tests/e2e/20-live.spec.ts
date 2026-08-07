import { existsSync, readFileSync } from 'node:fs';
import { SERVICES } from '../fake/services';
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
     * **一覧は種別で切り替える。** 全部縦に並べると、CS の局が100を超える環境で
     * 地上波が上のほうへ流れて見えなくなる。**開いたときは、いま映している局の種別**
     */
    test('チャンネル一覧を地上波/BS/CSで切り替えられる', async ({ page }) => {
        await goto(page, '/live');
        await expect(page.getByTestId('live-type-GR')).toHaveClass(/btn-active/);
        // 地上波を見ているので、一覧に出るのは地上波だけ
        const shown = page.getByTestId('live-channel');
        await expect(shown.first()).toBeVisible();
        for (const channel of await shown.all()) {
            await expect(channel).toHaveAttribute('data-channel', /^GR\//);
        }

        await page.getByTestId('live-type-BS').click();
        await expect(page.getByTestId('live-type-BS')).toHaveClass(/btn-active/);
        await expect(shown.first()).toHaveAttribute('data-channel', /^BS\//);
        // 切り替えただけでは選局しない。見ているものはそのまま
        await expect(page.getByTestId('live-title')).toBeVisible();
    });

    /*
     * **押せると分かる形にする。** 平らに並べていた頃は、文字が並んでいるだけに
     * 見えて押せると気付けなかった。枠を持たせ、指の形を変える
     */
    test('チャンネルは押せると分かる形にする', async ({ page }) => {
        await goto(page, '/live');
        const row = page.getByTestId('live-channel').first();
        await expect(row).toBeVisible();
        const look = await row.evaluate((el) => {
            const style = getComputedStyle(el);
            return { cursor: style.cursor, border: Number.parseFloat(style.borderTopWidth) };
        });
        expect(look.cursor).toBe('pointer');
        expect(look.border).toBeGreaterThan(0);
    });

    /*
     * **いま映しているものが分かるようにする。** 色だけだと、色の見え方が違う人に
     * 伝わらないので、文字でも出す
     */
    test('選局中のチャンネルが分かる', async ({ page }) => {
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        const second = channels.nth(1);
        await second.click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await expect(second).toHaveAttribute('data-current', 'true');
        await expect(second).toContainText('視聴中');
        // 印は1つだけ。ほかの行に残っていたら、どれを見ているのか分からない
        expect(await page.locator('[data-testid="live-channel"][data-current="true"]').count()).toBe(1);
    });

    /*
     * **開いたら、いま映しているものまで送っておく。** 局が100を超える環境では
     * 覚えていた局が画面の外にあるほうが普通で、探させるのはテレビを点けたときの
     * 振る舞いから遠い
     */
    test('開くと、選局中のチャンネルまでスクロールしてある', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 700 });
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        // 下のほうの局を選んでから開き直す
        const last = channels.last();
        const picked = await last.getAttribute('data-channel');
        await last.click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await goto(page, '/live');
        const row = page.locator(`[data-testid="live-channel"][data-channel="${picked}"]`);
        await expect(row).toHaveAttribute('data-current', 'true');
        // 一覧の見えている範囲に入っていること
        const inside = await row.evaluate((el) => {
            const list = el.closest('[data-testid="live-channels"]');
            if (list === null) return false;
            const a = el.getBoundingClientRect();
            const b = list.getBoundingClientRect();
            return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
        });
        expect(inside).toBe(true);
    });

    /*
     * **備え付けの操作は出さない。** あれの再生位置は「持っている範囲」を尺として
     * 描くので、0.05秒ごとに中身が届くたびに右へ左へ動く。放送に終わりは無いので、
     * 位置ではなく張り付いているかどうかを出す
     */
    test('自前の操作列を出し、備え付けは使わない', async ({ page }) => {
        await goto(page, '/live');
        await expect(page.getByTestId('live-video')).not.toHaveAttribute('controls', /.*/);
        await expect(page.getByTestId('live-controls')).toBeVisible();
        await expect(page.getByTestId('live-edge')).toBeVisible();
        await expect(page.getByTestId('live-play')).toBeVisible();
    });

    /*
     * 止める・再開するの繋がりだけ見る。
     *
     * **「止めた所から見られる」ところまでは、ここでは確かめられない。** 偽の
     * ffmpeg が流すものは MSE が受け取れないので、そもそも再生が始まらず、
     * 位置も動かない。動く中身での確認は実機で行う
     */
    test('止める・再開するが繋がっている', async ({ page }) => {
        await goto(page, '/live');
        const button = page.getByTestId('live-play');
        await expect(button).toBeVisible();

        await expect(button).toHaveAttribute('aria-label', '一時停止');
        await button.click();
        await expect(button).toHaveAttribute('aria-label', '再生');
        await button.click();
        await expect(button).toHaveAttribute('aria-label', '一時停止');
    });

    /*
     * **放送に終わりは無いと言っておく。** 何も言わないと MediaSource の尺は
     * 「いま持っている中でいちばん後ろ」になり、0.2秒ごとに中身が届くたびに
     * 伸びる。備え付けの再生位置が右端まで行っては少し左へ戻る、を繰り返す
     */
    test('再生位置に終わりを作らない', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await expect(async () => {
            const duration = await page
                .getByTestId('live-video')
                .evaluate((v) => (v as HTMLVideoElement).duration);
            expect(duration).toBe(Number.POSITIVE_INFINITY);
        }).toPass({ timeout: 15_000 });
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
     * **ffmpeg に渡すのは、放送が名乗っている番号。**
     *
     * 1本の物理チャンネルに複数の局が乗っているので局を名指しするのだが、
     * 渡す番号を間違えると ffmpeg はその局を探して見つけられず、**絵も音も
     * 出ない**。denpa の `services.id` は `network_id * 100000 + service_id` の
     * 内部IDで、TS の中には出てこない — 実際にこれを渡して再生できなくなった。
     */
    test('局は放送が名乗っている番号で名指しする', async ({ page, stack }) => {
        await goto(page, '/live');
        const target = page.getByTestId('live-channel').first();
        await target.click();
        await expect(page.getByTestId('live-title')).toBeVisible();

        await expect(() => {
            expect(existsSync(stack.liveArgsFile)).toBe(true);
        }).toPass({ timeout: 15_000 });
        const args = readFileSync(stack.liveArgsFile, 'utf8').split('\n');

        // 名指ししている先が、内部IDではなく放送の番号になっていること
        const video = args.find((a) => a.startsWith('0:p:') && a.endsWith(':v:0'));
        expect(video).toBeDefined();
        const named = Number(video?.slice('0:p:'.length, -':v:0'.length));
        const service = SERVICES.find((s) => s.serviceId === named);
        expect(service, `${named} は放送の番号ではない (内部IDを渡していないか)`).toBeDefined();
        expect(args).toContain(`0:p:${named}:a:0`);
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
        await expect(page.locator(`[data-testid="live-channel"][data-channel="${picked}"]`)).toHaveAttribute(
            'data-current',
            'true',
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
