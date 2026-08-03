import { expect, goto, test } from './helpers';

/**
 * ホーム画面に置いて、アプリのように開けること。
 *
 * 中身はキャッシュしない。録画一覧も番組表もサーバの今の状態が要るので、
 * 古いものを見せるくらいなら繋がらないと分かるほうがまし。
 */
test.describe('PWA', () => {
    test('マニフェストとアイコンが揃っている', async ({ page, request }) => {
        await goto(page, '/');
        await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');

        const res = await request.get('/manifest.webmanifest');
        expect(res.ok()).toBeTruthy();
        const manifest = await res.json();
        expect(manifest.name).toBe('denpa');
        // ホーム画面から開いたときにブラウザのUIを出さない
        expect(manifest.display).toBe('standalone');
        // 丸く切り抜かれる端末があるので、そのための版も要る
        expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBeTruthy();

        for (const icon of manifest.icons) {
            const image = await request.get(icon.src);
            expect(image.status(), icon.src).toBe(200);
        }
        // iOS はマニフェストのアイコンを使わない
        expect((await request.get('/apple-touch-icon.png')).status()).toBe(200);
    });

    test('サービスワーカーが登録され、APIは横取りしない', async ({ page }) => {
        await goto(page, '/');
        const registered = await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            return registration !== undefined;
        });
        expect(registered).toBeTruthy();

        // 録画の配信は数十GB、通知は繋ぎっぱなしのSSE。載せると壊れる
        const cached = await page.evaluate(async () => {
            const keys = await caches.keys();
            const entries = await Promise.all(
                keys.map(async (key) => (await (await caches.open(key)).keys()).map((r) => r.url)),
            );
            return entries.flat();
        });
        expect(cached.some((url) => url.includes('/api/'))).toBeFalsy();
    });

    test('狭い画面ではナビを畳んで、ページが横にはみ出さない', async ({ page }) => {
        /*
         * 5項目を横に並べると、スマートフォンの幅ではヘッダーのほうが画面より
         * 広くなり、ページ全体が横にスクロールしていた。番組表を横に流すのと
         * 混ざって扱いにくいので、狭い画面ではハンバーガーに畳む
         */
        for (const width of [390, 430, 768, 1280]) {
            await page.setViewportSize({ width, height: 780 });
            await goto(page, '/guide?type=GR');
            const doc = await page.evaluate(() => ({
                scrollW: document.documentElement.scrollWidth,
                clientW: document.documentElement.clientWidth,
            }));
            expect(doc.scrollW).toBeLessThanOrEqual(doc.clientW);
        }

        // 畳んだメニューからも行けること
        await page.setViewportSize({ width: 390, height: 780 });
        await goto(page, '/');
        const menu = page.getByTestId('nav-menu');

        /*
         * テーマの切り替えはハンバーガーの**横**に置く。`<details>` は行を
         * 占める箱なので、並べる指定が抜けていると切り替えが上の行へ押し出され、
         * ヘッダーが2段ぶんの厚さになっていた
         */
        const theme = (await page.getByTestId('theme-toggle').boundingBox())!;
        const burger = (await menu.locator('summary').boundingBox())!;
        expect(Math.abs(theme.y - burger.y)).toBeLessThan(theme.height);
        expect(theme.x).toBeLessThan(burger.x);

        await menu.locator('summary').click();
        await menu.getByRole('link', { name: '番組表' }).click();
        await page.waitForURL(/guide/);
    });
});
