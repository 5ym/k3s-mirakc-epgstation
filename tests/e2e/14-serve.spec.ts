import { expect, goto, recordOne, test } from './helpers';

const CREDENTIALS = { username: 'denpa', password: 'ひみつ' };

/**
 * 録画の配信と WebDAV。
 *
 * mpv も Kodi も、画面の前段に置くリダイレクト型の認証は扱えない。
 * ファイルを取りに来る口はベーシック認証で守る。
 *
 * **掛かる範囲は選べない。** 以前は「配信と WebDAV だけ / 画面も含めて全部」を
 * 選べたが、既定のままだと画面が誰にでも開き、しかも再生リンクのURLに
 * パスワードが埋まっているので、画面を開ければ全部見えていた。
 */
test.describe('資格情報が無いとき', () => {
    test('画面も断る', async ({ anonymous }) => {
        const res = await anonymous('/');
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Basic');
    });

    test('ファイルの口も断る', async ({ anonymous }) => {
        const res = await anonymous('/api/recordings/1/file');
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Basic');
    });

    test('WebDAV も断る', async ({ anonymous }) => {
        const res = await anonymous('/dav/', { method: 'PROPFIND' });
        expect(res.status).toBe(401);
    });

    /*
     * **生死確認だけは通す。** ここを守ると Kubernetes の livenessProbe が落ち、
     * Pod が再起動を繰り返す (この E2E のスタックも起動待ちで固まった)
     */
    test('生死確認は通す', async ({ anonymous }) => {
        const res = await anonymous('/api/health');
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);
    });
});

test.describe('設定画面からの認証', () => {
    test.use({ httpCredentials: CREDENTIALS });

    test('設定画面から認証を変えられる', async ({ page }) => {
        await goto(page, '/settings');
        // ユーザー名は固定。入力欄そのものが無い
        await expect(page.getByTestId('auth-user')).toHaveText('denpa');
        /*
         * いま効いているパスワードをそのまま出す。Kodi や VLC に入れるときに要るものを
         * 隠していると、思い出せないたびに作り直すことになり、そのたびに
         * 登録済みの端末が全部つながらなくなる
         */
        await expect(page.getByTestId('auth-password')).toHaveValue('ひみつ');
        await expect(page.getByTestId('auth-password')).toHaveAttribute('type', 'password');
        await page.getByTestId('auth-reveal').click();
        await expect(page.getByTestId('auth-password')).toHaveAttribute('type', 'text');

        // 範囲は選ばせない。何が守られているかを書いて出すだけ
        await expect(page.getByTestId('auth-scope-note')).toBeVisible();
        await expect(page.getByTestId('auth-scope-note')).toContainText('まとめて守ります');
    });

    test('パスワードは空にできない', async ({ page }) => {
        // 空にすると録画も WebDAV も誰でも取れる状態になり、しかもそれが画面から分からない
        await goto(page, '/settings');
        await page.getByTestId('auth-password').fill('');
        await page.getByTestId('save-auth').click();
        await expect(page.getByText('パスワードは空にできません')).toBeVisible();

        // 効いているものは変わっていない
        await goto(page, '/settings');
        await expect(page.getByTestId('auth-password')).toHaveValue('ひみつ');
    });

    /*
     * **作り直すと、その端末は締め出される。** 画面にもベーシック認証が掛かるので、
     * ブラウザが持っている古いほうでは次の読み込みから 401 になる。押した本人が
     * 新しいものを受け取れないので、作り直したぶんは**起動ログにも出している**。
     *
     * ここで押してしまうと後ろのテストが全部入れなくなるので、E2E では
     * 「入れたものが効く」ところまでを見る。作る中身そのものは単体試験
     * (`src/lib/server/auth.test.ts`) で押さえてある
     */
    test('入れたパスワードがその場で効く', async ({ page, anonymous, stack }) => {
        // btoa は Latin-1 しか受けない。日本語のパスワードは UTF-8 で組む
        const auth = (password: string) =>
            `Basic ${Buffer.from(`denpa:${password}`, 'utf8').toString('base64')}`;

        await goto(page, '/settings');
        await page.getByTestId('auth-password').fill('あたらしい');
        await page.getByTestId('save-auth').click();

        // 新しいほうで通り、古いほうでは通らない = 効いている
        await expect
            .poll(
                async () => (await anonymous('/', { headers: { authorization: auth('あたらしい') } })).status,
            )
            .toBe(200);
        expect((await anonymous('/', { headers: { authorization: auth('ひみつ') } })).status).toBe(401);

        // 後ろのテストのために戻す。ブラウザはもう入れないので直に投げる
        const restored = await anonymous('/settings?/saveAuth', {
            method: 'POST',
            headers: {
                authorization: auth('あたらしい'),
                origin: stack.appUrl,
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ basicAuthPassword: 'ひみつ' }),
        });
        expect(restored.status).toBeLessThan(400);
        await goto(page, '/settings');
        await expect(page.getByTestId('auth-password')).toHaveValue('ひみつ');
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

    test('DELETE を受けて、denpa 側の一覧からも消える', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        const { id, libraryPath: path } = await recordOne(page, request);
        expect(path).toContain(stack.libraryDir);

        // /dav からの相対パスに直す
        const relative = path.replace(`${stack.libraryDir}/`, '');
        const href = `/dav/${relative.split('/').map(encodeURIComponent).join('/')}`;

        const res = await request.fetch(href, { method: 'DELETE' });
        expect(res.status()).toBe(204);

        // 実体だけでなく DB も更新される。定期照合を待たずに一覧から消える
        await goto(page, '/');
        await expect(page.locator(`[data-recording-id="${id}"]`)).toHaveCount(0);

        // 消した理由は行ではなく詳細に出す (生の文言で行が分厚くならないように)
        await goto(page, '/?deleted=1');
        const row = page.locator(`[data-recording-id="${id}"]`);
        await expect(row).toContainText('削除済み');
        await row.getByTestId('detail-button').click();
        await expect(page.getByTestId('detail-error')).toContainText('WebDAV から削除されました');
    });

    test('denpa が知らないファイルは消させない', async ({ request }) => {
        // 手で置いたものを WebDAV 越しに消せると、denpa の外の都合で消える
        const res = await request.fetch('/dav/', { method: 'DELETE' });
        expect([403, 405]).toContain(res.status());
    });
});
