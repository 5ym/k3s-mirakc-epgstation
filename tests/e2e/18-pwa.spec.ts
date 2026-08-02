import { expect, test } from '@playwright/test';
import { goto } from './helpers';

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
});
