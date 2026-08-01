import { expect, test } from '@playwright/test';
import { goto, syncEpg } from './helpers';

test.describe('ダッシュボードと画面遷移', () => {
    test('データ放送のチャンネルは取り込まない', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/guide?type=GR');
        // 映像が入っていないので録っても中身が無い。番組表に出るとルールが引っかけて
        // 録画が失敗する
        await expect(page.locator('[data-testid="guide-grid"]')).not.toContainText('MXデータ');
    });

    test('EPG取得後に局・番組が反映され、全ページを開ける', async ({ page, request }) => {
        await syncEpg(request);

        // 状態と番組数は番組表に出す。古いことに気づくのはこの画面なので
        await goto(page, '/guide');
        await expect(page.getByTestId('status')).toContainText('Mirakurun');
        await expect(page.locator('.badge').filter({ hasText: '局' })).toContainText('局 3');

        for (const [name, heading] of [
            ['nav-guide', '番組表'],
            ['nav-rules', '自動予約ルール'],
            ['nav-settings', '設定'],
            ['nav-home', '予約と録画'],
        ] as const) {
            await page.getByTestId(name).click();
            await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
        }
    });

    test('ダッシュボードのボタンからEPGを取り直せる', async ({ page }) => {
        await goto(page, '/guide');
        await page.getByTestId('sync-button').click();
        await expect(page.getByTestId('sync-result')).toContainText('局 3');
    });

    test('番組表はグリッドで出て、キーワード検索ではリストになる', async ({ page }) => {
        await goto(page, '/guide');

        // 既定は地上波のグリッド。時間×チャンネルで並ぶ
        await expect(page.getByTestId('guide-grid')).toBeVisible();
        await expect(page.getByTestId('grid-program').first()).toBeVisible();

        // 種別で切り替えられる
        await page.getByTestId('type-BS').click();
        await expect(page.getByTestId('grid-program').first()).toBeVisible();
        await page.getByTestId('type-GR').click();

        // いまが何時かの線が出て、開いた時点でそこまでスクロールされている
        await expect(page.getByTestId('now-line')).toBeVisible();
        const scrolled = await page.getByTestId('guide-grid').evaluate((el) => (el as HTMLElement).scrollTop);
        expect(scrolled).toBeGreaterThan(0);

        // 番組をクリックすると詳細が出る。ここで予約するかどうか決める
        await page.getByTestId('program-button').first().click();
        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail).toContainText('のテスト番組');
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);
    });

    test('テーマは端末に合わせる/ライト/ダークを切り替えられ、再読み込みしても残る', async ({ page }) => {
        await goto(page, '/');
        const html = page.locator('html');
        const toggle = page.getByTestId('theme-toggle');

        // 既定は端末の設定に従う。テストはダークの端末として動かしている
        await expect(toggle).toHaveAttribute('data-mode', 'system');
        await expect(html).toHaveAttribute('data-theme', 'dark');

        await toggle.click();
        await expect(html).toHaveAttribute('data-theme', 'light');

        await toggle.click();
        await expect(html).toHaveAttribute('data-theme', 'dark');
        await expect(toggle).toHaveAttribute('data-mode', 'dark');

        // 明示した設定は再読み込みしても残る(ちらつかないようハイドレーション前に当てている)
        await goto(page, '/guide');
        await expect(html).toHaveAttribute('data-theme', 'dark');
        await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-mode', 'dark');

        // 一周して端末に合わせるへ戻る
        await page.getByTestId('theme-toggle').click();
        await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-mode', 'system');
        await goto(page, '/');
        await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-mode', 'system');
    });

    test('アクション中はボタンを押せなくし、ローディングを出す', async ({ page }) => {
        await goto(page, '/guide');

        // EPG取得は実機だと数秒かかる。その間に二度押しできないことを確かめたいので遅らせる
        await page.route('**/guide?/sync', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await route.continue();
        });

        const button = page.getByTestId('sync-button');
        await button.click();

        await expect(button).toBeDisabled();
        await expect(page.getByTestId('loading-bar')).toHaveAttribute('data-loading', 'true');

        await expect(page.getByTestId('sync-result')).toBeVisible();
        await expect(button).toBeEnabled();
        await expect(page.getByTestId('loading-bar')).not.toHaveAttribute('data-loading', 'true');
    });

    test('サーバ側の変化が通知で届く', async ({ page }) => {
        await goto(page, '/');

        // 受け取ったイベントを溜める。ポーリングではなく push で届くことを確かめる
        await page.evaluate(() => {
            const seen: string[] = [];
            (window as unknown as { seen: string[] }).seen = seen;
            const source = new EventSource('/api/events');
            for (const name of ['recordings', 'reservations', 'live']) {
                source.addEventListener(name, () => seen.push(name));
            }
        });

        // 予約の競合を計算し直すと reservations が飛ぶ
        await page.getByRole('button', { name: '競合を再計算' }).click();

        await expect
            .poll(async () => await page.evaluate(() => (window as unknown as { seen: string[] }).seen))
            .toContain('reservations');
    });

    test('番組表の検索窓はルール画面で結果を出し、そのままルールにできる', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/guide');

        // 条件を書く場所は1箇所。番組表からはキーワードを渡すだけ
        await page.getByTestId('filter-keyword').fill('テストアニメ');
        await page.getByRole('button', { name: '検索' }).click();
        await page.waitForURL(/\/rules\?/);

        await expect(page.getByTestId('preview')).toContainText('録れる番組は');
        const rows = page.getByTestId('preview-row');
        await expect(rows.first()).toBeVisible();
        for (const row of await rows.all()) {
            await expect(row).toContainText('テストアニメ');
        }

        // 種別で絞り込める(ルールの条件そのもの)
        await page.getByTestId('channel-summary').click();
        await page.getByTestId('rule-types').locator('input[value="BS"]').check();
        await page.getByTestId('rule-preview').click();
        await page.waitForURL(/serviceTypes=BS/);
        for (const row of await page.getByTestId('preview-row').all()) {
            await expect(row).toContainText('BS11イレブン');
        }

        // そのまま保存できる
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row').first()).toContainText('テストアニメ');

        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
        await goto(page, '/');
        for (let i = 0; i < 80; i++) {
            const buttons = page.getByTestId('cancel-button');
            if ((await buttons.count()) === 0) break;
            await buttons.first().click();
            await page.waitForTimeout(80);
        }
    });
});
