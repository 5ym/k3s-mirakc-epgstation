import { rmSync } from 'node:fs';
import { FUJI, MX } from '../fake/services';
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
     * 画面から取りに行けるのは**地上波だけ**。BS/CS はロゴが地上波よりさらに
     * 流れてこないので、押した人を待たせるだけになる (10分ごとの定期取得に任せる)。
     * 地上波は中継ごとに乗っている局が違うので、チューナー2つで並べて回る。
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

        // 2チャンネルぶんを見終えて、結果が残っていること
        await goto(page, '/tuners');
        await expect(page.getByTestId('logo-sweep-count')).toContainText('2 / 2');
        await expect(page.getByTestId('logo-sweep-done')).toContainText('拾いました');

        // 何局ぶん持っているかもここに出す。番組表にロゴが出ないとき、
        // まだ拾えていないのか出し方が悪いのかを見分けるため
        await expect(page.getByTestId('status-logos')).toContainText('局');

        // もう無いのに押したときも黙らないこと。何も起きないと壊れて見える
        await page.getByTestId('logo-sweep').click();
        await expect(page.getByTestId('tuner-error')).toContainText('もう全部持っています');

        // 番組表の見出しにも出る
        await goto(page, '/guide?type=GR');
        await expect(page.locator(`img[src="/api/services/${MX.id}/logo"]`).first()).toBeVisible();
    });
});
