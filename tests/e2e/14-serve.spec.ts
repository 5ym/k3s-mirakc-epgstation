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
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('予約と録画');
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

test.describe('設定画面からの認証', () => {
    test.use({ httpCredentials: CREDENTIALS });

    test('設定画面から認証を変えられる', async ({ page }) => {
        await goto(page, '/settings');
        await expect(page.getByTestId('auth-user')).toHaveValue('denpa');
        // env から来ている間は「設定済み」とだけ出す
        await expect(page.getByTestId('auth-password')).toHaveAttribute('placeholder', /設定済み/);

        await page.getByTestId('auth-scope').selectOption('all');
        await page.getByTestId('save-auth').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();

        // 保存されていること
        await goto(page, '/settings');
        await expect(page.getByTestId('auth-scope')).toHaveValue('all');

        await page.getByTestId('auth-scope').selectOption('files');
        await page.getByTestId('save-auth').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();
        await goto(page, '/settings');
        await expect(page.getByTestId('auth-scope')).toHaveValue('files');
        // この範囲だと画面が素通しになるので、その旨を出す
        await expect(page.getByTestId('auth-warning')).toBeVisible();
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

    test('PROPFIND で保存先の中身を返す', async ({ request }) => {
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

    test('保存先の外は見せない', async ({ request }) => {
        const res = await request.fetch('/dav/../../etc/passwd', { method: 'PROPFIND' });
        expect([404, 405]).toContain(res.status());
    });

    test('書き込みは断る', async ({ request }) => {
        const res = await request.fetch('/dav/x.mkv', { method: 'PUT', data: 'x' });
        expect([404, 405]).toContain(res.status());
    });

    test('DELETE を受けて、denpa 側の一覧からも消える', async ({ page, request }) => {
        await goto(page, '/');
        const recording = page.getByTestId('recording-row').first();
        await expect(recording).toBeVisible();
        const id = await recording.getAttribute('data-recording-id');
        const path = (await recording.getAttribute('data-library-path')) ?? '';
        expect(path).toContain('/tmp/denpa-e2e/library/');

        // /dav からの相対パスに直す
        const relative = path.replace('/tmp/denpa-e2e/library/', '');
        const href = `/dav/${relative.split('/').map(encodeURIComponent).join('/')}`;

        const res = await request.fetch(href, { method: 'DELETE' });
        expect(res.status()).toBe(204);

        // 実体だけでなく DB も更新される。定期照合を待たずに一覧から消える
        await goto(page, '/');
        await expect(page.locator(`[data-recording-id="${id}"]`)).toHaveCount(0);

        await goto(page, '/?deleted=1');
        await expect(page.locator(`[data-recording-id="${id}"]`)).toContainText('WebDAV から削除されました');
    });

    test('denpa が知らないファイルは消させない', async ({ request }) => {
        // 手で置いたものを WebDAV 越しに消せると、denpa の外の都合で消える
        const res = await request.fetch('/dav/', { method: 'DELETE' });
        expect([403, 405]).toContain(res.status());
    });
});
