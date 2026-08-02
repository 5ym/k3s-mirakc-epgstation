import { rmSync } from 'node:fs';
import { expect, goto, reserveSoon, syncEpg, test } from './helpers';

/** 偽 mirakc の BS の局。番組が短いので、録画がすぐ始まる */
const BS_SERVICE = 400211;

/**
 * 局ロゴ。
 *
 * mirakc は Mirakurun と違ってロゴを TS から集めない。denpa が録画のついでに
 * 放送波から拾う (CDT の実体と、SDT の「どの局のものか」を突き合わせる)。
 */
test.describe('局ロゴ', () => {
    test('録画のついでに放送波から拾い、番組表に出る', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // 先に走ったテストの録画で拾えていることがあるので、一度捨てる
        rmSync(`${stack.root}/logos/${BS_SERVICE}.png`, { force: true });
        // 持っていなければ配れない
        expect((await request.get(`/api/services/${BS_SERVICE}/logo`)).status()).toBe(404);

        await reserveSoon(page, request, 'BS');

        // 録画が始まってストリームが流れ出せば、そのうち拾える
        await expect(async () => {
            const logo = await request.get(`/api/services/${BS_SERVICE}/logo`);
            expect(logo.status()).toBe(200);
            expect(logo.headers()['content-type']).toContain('image/png');
        }).toPass({ timeout: 120_000 });

        // 番組表の見出しにも出る
        await goto(page, '/guide?type=BS');
        await expect(page.locator(`img[src="/api/services/${BS_SERVICE}/logo"]`).first()).toBeVisible();
    });
});
