import { rmSync } from 'node:fs';
import { BS_NO_LOGO, BS11, FUJI, MX } from '../fake/services';
import { expect, goto, syncEpg, test } from './helpers';

/**
 * 局ロゴ。
 *
 * mirakc は Mirakurun と違ってロゴを TS から集めない。denpa が放送波から拾う
 * (CDT の実体と、SDT の「どの局のものか」を突き合わせる)。
 *
 * **開くのは物理チャンネル。** サービス単位で開くと、mirakc がその局に要るPIDだけを
 * 通すので、どの局のPMTにも載っていない CDT (PID 0x0029) はまるごと落ちる。
 * 実機では BS をサービス単位で3分・427MB 読んでも1つも来なかった。
 * 偽 mirakc も同じようにしてある (ロゴを載せるのはチャンネル丸ごとの口だけ)。
 */
test.describe('局ロゴ', () => {
    /**
     * 画面から取りに行くと、地上波も衛星もまとめて回る。地上波は中継ごとに
     * 乗っている局が違うので、チューナー2つで並べて回る。
     */
    test('地上波を2チャンネル並べて拾い、番組表に出る', async ({ page, request, stack }) => {
        test.setTimeout(120_000);
        await syncEpg(request);

        // 先に走ったテストで拾えていることがあるので、一度捨てる
        for (const service of [MX, FUJI]) {
            rmSync(`${stack.root}/logos/${service.id}.png`, { force: true });
        }
        // 持っていなければ配れない
        expect((await request.get(`/api/services/${MX.id}/logo`)).status()).toBe(404);

        // 普段は10分ごとに少しずつ拾っている。押すと今すぐ取りに行く
        await goto(page, '/tuners');
        await page.getByTestId('logo-sweep').click();

        /*
         * **空いている地上波チューナーの数だけ並べる。** 種別を見ずに
         * 「1本でも空いていれば」で数えていた頃は、地上波が1本しか空いて
         * いなくても2チャンネルを同時に開きに行っていた
         */
        await expect(page.getByTestId('tuner-notice')).toContainText('チューナー 2 本');

        /*
         * 押しても何も起きていないように見えないこと。1チャンネルに数分かかるので、
         * どこまで進んだかを出さないと動いているのか失敗したのか区別が付かない
         */
        await expect(page.getByTestId('logo-sweep-progress')).toBeVisible();

        for (const service of [MX, FUJI]) {
            await expect(async () => {
                const logo = await request.get(`/api/services/${service.id}/logo`);
                expect(logo.status()).toBe(200);
                expect(logo.headers()['content-type']).toContain('image/png');
                /*
                 * 色の表を入れ直してあること。放送に乗るのはパレットの抜けた PNG で、
                 * そのまま置くとブラウザは何も描かない。実機では15局ぶん拾えているのに
                 * 番組表が空のままだった
                 */
                const bytes = await logo.body();
                expect(bytes.includes(Buffer.from('PLTE'))).toBeTruthy();
                expect(bytes.includes(Buffer.from('tRNS'))).toBeTruthy();
            }).toPass({ timeout: 60_000 });
        }

        /*
         * 見終えて、結果が残っていること。
         *
         * 地上波が揃ってもまだ終わりではない。同じ一回で衛星の中継も回っていて、
         * そちらは**最後に拾ってからしばらく待って**から切り上げる (カルーセルは
         * まとまって来るので、来なくなったことが分かるまで開けておく)
         */
        await expect(async () => {
            await goto(page, '/tuners');
            await expect(page.getByTestId('logo-sweep-done')).toContainText('拾いました');
        }).toPass({ timeout: 60_000 });

        // 何局ぶん持っているかもここに出す。番組表にロゴが出ないとき、
        // まだ拾えていないのか出し方が悪いのかを見分けるため
        await expect(page.getByTestId('status-logos')).toContainText('局');

        /*
         * 取りに行くものが無くなったら**口も消える**。押しても「もう全部持って
         * います」と断るだけのボタンを出しておく意味がない。
         *
         * ここで消えるのは、衛星ぶんも同じ一回で拾えているから。地上波と衛星は
         * 伝送方式が違うだけで、開けば両方流れてくる
         */
        await expect(page.getByTestId('logo-sweep')).toHaveCount(0);

        // 番組表の見出しにも出る
        await goto(page, '/guide?type=GR');
        await expect(page.locator(`img[src="/api/services/${MX.id}/logo"]`).first()).toBeVisible();
    });
});

/**
 * 衛星のロゴ。
 *
 * **地上波とは伝送方式が違う。** CDT には載らず、データカルーセル (DSM-CC) で
 * 流れてくる (ARIB TR-B15)。PAT → エンジニアリングサービス (929) の PMT →
 * component_tag 0x79/0x7A の ES → DII → DDB と辿って初めて拾える。
 *
 * 読めていなかった頃は、実機で BS を26中継・CS を12中継ぶん開いても
 * 0/38・0/54 のままだった (地上波は12中継で 29/29 揃う)。
 */
test.describe('衛星の局ロゴ', () => {
    test('データカルーセルから拾って番組表に出る', async ({ page, request, stack }) => {
        test.setTimeout(120_000);
        await syncEpg(request);

        rmSync(`${stack.root}/logos/${BS11.id}.png`, { force: true });
        expect((await request.get(`/api/services/${BS11.id}/logo`)).status()).toBe(404);

        await goto(page, '/tuners');
        await page.getByTestId('logo-sweep').click();

        await expect(async () => {
            const logo = await request.get(`/api/services/${BS11.id}/logo`);
            expect(logo.status()).toBe(200);
            expect(logo.headers()['content-type']).toContain('image/png');
        }).toPass({ timeout: 60_000 });

        await goto(page, '/guide?type=BS');
        await expect(page.locator(`img[src="/api/services/${BS11.id}/logo"]`).first()).toBeVisible();
    });

    /**
     * ロゴを流していない中継を**見切ること**。
     *
     * 実機の CS は12中継のどれにもロゴのカルーセルが無く、BS も26中継のうち
     * 25は外れだった。見切れないと、その局はいつまでも「まだ取れていない」
     * ままになり、取りに行く口が消えず、見回りのたびに開き直すことになる。
     *
     * PAT にエンジニアリングサービス (929) が居ないことで分かるので、
     * 数秒で次へ行けるはず。
     */
    test('ロゴを流していない中継は見切って、取れない局として数える', async ({ page, request, stack }) => {
        test.setTimeout(120_000);
        await syncEpg(request);

        rmSync(`${stack.root}/logos/${BS_NO_LOGO.id}.png`, { force: true });

        await goto(page, '/tuners');
        // 既に見切ったあとなら口は出ていない。出ていれば押して確かめる
        const sweep = page.getByTestId('logo-sweep');
        if ((await sweep.count()) > 0) await sweep.click();

        /*
         * 取りに行くところが無くなる = 外れの中継を覚えた、ということ。
         * 覚えられていないと `missing()` に残り続けて口が消えない
         */
        await expect(async () => {
            await goto(page, '/tuners');
            await expect(page.getByTestId('logo-sweep')).toHaveCount(0);
        }).toPass({ timeout: 90_000 });

        // 取れない局は取れないと書く。黙って足りないままだと不具合と区別が付かない
        await expect(page.getByTestId('status-logos')).toContainText('局');
        await expect(page.locator('[data-testid="status-card"]')).toContainText(
            '放送側がロゴを流していないので取れません',
        );
        expect((await request.get(`/api/services/${BS_NO_LOGO.id}/logo`)).status()).toBe(404);
    });
});
