import { rmSync } from 'node:fs';
import { expect, goto, syncEpg, test } from './helpers';

/** 偽 mirakc の BS の局 */
const BS_SERVICE = 400211;

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
    test('チャンネルを丸ごと開いて拾い、番組表に出る', async ({ page, request, stack }) => {
        test.setTimeout(120_000);
        await syncEpg(request);

        // 先に走ったテストで拾えていることがあるので、一度捨てる
        rmSync(`${stack.root}/logos/${BS_SERVICE}.png`, { force: true });
        // 持っていなければ配れない
        expect((await request.get(`/api/services/${BS_SERVICE}/logo`)).status()).toBe(404);

        // 普段は10分ごとに少しずつ拾っている。押すと今すぐ取りに行く
        await goto(page, '/tuners');
        await page.getByTestId('logo-sweep').click();

        await expect(async () => {
            const logo = await request.get(`/api/services/${BS_SERVICE}/logo`);
            expect(logo.status()).toBe(200);
            expect(logo.headers()['content-type']).toContain('image/png');
        }).toPass({ timeout: 60_000 });

        // 何局ぶん持っているかはチューナー画面に出す。番組表にロゴが出ないとき、
        // まだ拾えていないのか出し方が悪いのかを見分けるため
        await goto(page, '/tuners');
        await expect(page.getByTestId('status-logos')).toContainText('局');

        // 番組表の見出しにも出る
        await goto(page, '/guide?type=BS');
        await expect(page.locator(`img[src="/api/services/${BS_SERVICE}/logo"]`).first()).toBeVisible();
    });
});
