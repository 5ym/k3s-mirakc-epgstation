import { expect, type Page, test } from '@playwright/test';
import { JELLYFIN_URL } from '../../playwright.config';
import { MX } from '../fake/services';
import { goto, syncEpg } from './helpers';

/**
 * Jellyfin にライブTVとして食わせるための出口。
 *
 * 偽Mirakurunが返すのは本物のTSではないので「映像が映るか」までは見られない。
 * ここで確かめるのは配信の骨組み — プレイリストが denpa 自身を指していること、
 * ストリームが開いてバイトが流れ始めること、切断でチューナーが解放されること。
 */
async function stopAllSessions(page: Page): Promise<void> {
    await goto(page, '/');
    for (let i = 0; i < 20; i++) {
        const buttons = page.getByTestId('live-stop');
        if ((await buttons.count()) === 0) return;
        await buttons.first().click();
        await page.waitForTimeout(100);
    }
}

/** ストリームを掴んだままにするページを開く。掴んだ状態でUIを確認するため */
async function openViewer(context: import('@playwright/test').BrowserContext, url: string) {
    const viewer = await context.newPage();
    await viewer.goto('/');
    await viewer.evaluate(async (target) => {
        // ヘッダが返るまでは待つ。ここまで来ればサーバ側に中継が立っている
        const res = await fetch(target);
        const reader = res.body!.getReader();
        void (async () => {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) return;
            }
        })();
    }, url);
    return viewer;
}

test.describe('Jellyfin へのライブ配信', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await stopAllSessions(page);
    });

    test('M3U が denpa 自身の変換済みストリームを指す', async ({ page }) => {
        await goto(page, '/');
        const m3u = await page.evaluate(async () => {
            const res = await fetch('/api/iptv/playlist.m3u');
            return { status: res.status, text: await res.text() };
        });

        expect(m3u.status).toBe(200);
        expect(m3u.text).toContain('#EXTM3U');
        expect(m3u.text).toContain('tvg-id=');
        // Mirakurun の生TSではなく denpa の変換済みストリームを向いていること
        expect(m3u.text).toContain('/api/live/');
        expect(m3u.text).toContain('/h264');
        expect(m3u.text).not.toContain('40772');
    });

    test('M3U のプロファイルを切り替えられる', async ({ page }) => {
        await goto(page, '/');
        const m3u = await page.evaluate(async () => {
            const res = await fetch('/api/iptv/playlist.m3u?profile=av1');
            return res.text();
        });
        expect(m3u).toContain('/av1');
        expect(m3u).not.toContain('/h264');
    });

    test('XMLTV にチャンネルと番組が並ぶ', async ({ page }) => {
        await goto(page, '/');
        const guide = await page.evaluate(async () => {
            const res = await fetch('/api/iptv/xmltv.xml');
            return { status: res.status, text: await res.text() };
        });

        expect(guide.status).toBe(200);
        expect(guide.text).toContain('<tv generator-info-name="denpa">');
        expect(guide.text).toContain(`<channel id="${'3239123608'}">`);
        expect(guide.text).toContain('<programme start=');
        // M3U の tvg-id と XMLTV の channel が一致していないと Jellyfin が紐付けられない
        expect(guide.text).toContain('channel="3239123608"');
    });

    test('H.264 プロファイルは MPEG-TS で流れる', async ({ page }) => {
        await goto(page, '/');
        const result = await page.evaluate(async (serviceId) => {
            const controller = new AbortController();
            const res = await fetch(`/api/live/${serviceId}/h264`, { signal: controller.signal });
            const first = await res.body!.getReader().read();
            controller.abort();
            return {
                status: res.status,
                type: res.headers.get('content-type'),
                bytes: first.value?.length ?? 0,
            };
        }, MX.id);

        expect(result.status).toBe(200);
        expect(result.type).toBe('video/mp2t');
        expect(result.bytes).toBeGreaterThan(0);
    });

    test('AV1 プロファイルは Matroska で流れる', async ({ page }) => {
        await goto(page, '/');
        const result = await page.evaluate(async (serviceId) => {
            const controller = new AbortController();
            const res = await fetch(`/api/live/${serviceId}/av1`, { signal: controller.signal });
            const first = await res.body!.getReader().read();
            controller.abort();
            return {
                status: res.status,
                type: res.headers.get('content-type'),
                bytes: first.value?.length ?? 0,
            };
        }, MX.id);

        expect(result.status).toBe(200);
        expect(result.type).toBe('video/x-matroska');
        expect(result.bytes).toBeGreaterThan(0);
    });

    test('知らないプロファイルは断る', async ({ page }) => {
        await goto(page, '/');
        const status = await page.evaluate(
            async (serviceId) => (await fetch(`/api/live/${serviceId}/vp9`)).status,
            MX.id,
        );
        expect(status).toBe(503);
    });

    test('配信中はダッシュボードに出て、切断するとチューナーが解放される', async ({ page, context }) => {
        const viewer = await openViewer(context, `/api/live/${MX.id}/h264`);

        await goto(page, '/');
        const session = page.getByTestId('live-session').first();
        await expect(session).toBeVisible();
        await expect(session).toContainText('h264');

        await session.getByTestId('live-stop').click();
        await expect(page.getByTestId('live-session')).toHaveCount(0);
        await viewer.close();
    });

    test('ダッシュボードのボタンで Jellyfin にライブTVを登録できる', async ({ page, request }) => {
        await goto(page, '/');
        await page.getByTestId('register-livetv').click();

        const result = page.getByTestId('register-result');
        await expect(result).toContainText('チューナー: 追加');
        await expect(result).toContainText('番組表: 追加');
        await expect(result).toContainText('/api/iptv/playlist.m3u?profile=h264');
        await expect(result).toContainText('/api/iptv/xmltv.xml');

        // 2回押しても重複しない
        await page.getByTestId('register-livetv').click();
        await expect(result).toContainText('チューナー: 既存のまま');

        // 別オリジンなので、ブラウザの fetch(CORSに掛かる)ではなく request フィクスチャで読む
        const state = await (await request.get(`${JELLYFIN_URL}/__control/state`)).json();
        expect(state.tunerHosts).toHaveLength(1);
        expect(state.listingProviders).toHaveLength(1);
        expect(state.tunerHosts[0].Type).toBe('m3u');
        expect(state.listingProviders[0].Type).toBe('xmltv');
        // 登録しただけでは反映されないので、番組表の取り込みも促していること
        expect(state.guideRefreshCount).toBeGreaterThan(0);
    });
});
