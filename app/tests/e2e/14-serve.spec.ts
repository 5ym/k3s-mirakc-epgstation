import { expect, test } from '@playwright/test';
import { goto } from './helpers';

const CREDENTIALS = { username: 'denpa', password: 'ひみつ' };

/**
 * 録画の配信と WebDAV。
 *
 * mpv も Kodi も、画面の前段に置くリダイレクト型の認証は扱えない。
 * ファイルを取りに来る口だけベーシック認証をかけ、画面は素通しにしている。
 */
test.describe('配信とベーシック認証', () => {
    test('画面には認証がかからない', async ({ page }) => {
        await goto(page, '/');
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('録画');
    });

    test('ファイルの口は資格情報が無いと断る', async ({ request }) => {
        const res = await request.get('/api/recordings/1/file');
        expect(res.status()).toBe(401);
        expect(res.headers()['www-authenticate']).toContain('Basic');
    });

    test('WebDAV も資格情報が無いと断る', async ({ request }) => {
        const res = await request.fetch('/dav/', { method: 'PROPFIND' });
        expect(res.status()).toBe(401);
    });
});

test.describe('WebDAV', () => {
    test.use({ httpCredentials: CREDENTIALS });

    test('OPTIONS で DAV サーバだと名乗る', async ({ request }) => {
        const res = await request.fetch('/dav/', { method: 'OPTIONS' });
        expect(res.status()).toBe(204);
        expect(res.headers().dav).toBe('1');
        expect(res.headers().allow).toContain('PROPFIND');
    });

    test('PROPFIND でライブラリの中身を返す', async ({ request }) => {
        const res = await request.fetch('/dav/', {
            method: 'PROPFIND',
            headers: { Depth: '1' },
        });
        expect(res.status()).toBe(207);
        const body = await res.text();
        expect(body).toContain('<D:multistatus');
        // ルート自身はコレクションとして出る
        expect(body).toContain('<D:collection/>');
        expect(body).toContain('<D:href>');
    });

    test('ライブラリの外は見せない', async ({ request }) => {
        const res = await request.fetch('/dav/../../etc/passwd', { method: 'PROPFIND' });
        expect([404, 405]).toContain(res.status());
    });

    test('書き込みは断る', async ({ request }) => {
        const res = await request.fetch('/dav/x.mkv', { method: 'PUT', data: 'x' });
        expect([404, 405]).toContain(res.status());
    });
});
