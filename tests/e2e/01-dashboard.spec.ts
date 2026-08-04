import { expect, goto, syncEpg, test } from './helpers';

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

        /*
         * 番組数は番組表に出す。古いことに気づくのはこの画面なので。
         *
         * 局は4つ (データ放送の局は録画対象にならないので入らない)。
         * うち1つは**番組表がまだ空**の局 — まだ集め終えていない局は
         * 本物でも普通にあるので、それでも画面が出ることを一緒に見ておく
         */
        await goto(page, '/guide');
        await expect(page.getByTestId('counts')).toContainText('局 4');

        for (const [name, heading] of [
            ['nav-guide', '番組表'],
            ['nav-rules', '自動予約ルール'],
            ['nav-tuners', 'チューナー'],
            ['nav-settings', '設定'],
            ['nav-home', '予約と録画'],
        ] as const) {
            await page.getByTestId(name).click();
            await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
        }
    });

    test('チューナー画面にカードリーダーの状態が出る', async ({ page }) => {
        await goto(page, '/tuners');
        /*
         * **「チューナーの空き」に並べてある。** 同じ機材の話なので、
         * わざわざ別の枠を作って見るところを増やさない
         * (エージェントの生死も、繋がらなければその枠に理由が出る)
         */
        const card = page.getByTestId('tuner-card');
        // 相手待ちなので後から流れてくる
        await expect(card.getByTestId('status-card-reader')).toHaveText('OK');
        await expect(card).toContainText('Fake Card Reader');
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

        // いまが何時かの線が出て、開いた時点でそこが見えているところまで動いている。
        // 位置を offsetTop で測っていた頃は、ナビや見出しの高さまで足し込まれて
        // その分だけ行き過ぎ、線が上に流れて見えなくなっていた
        await expect(page.getByTestId('now-line')).toBeVisible();
        const view = await page.getByTestId('guide-grid').evaluate((el) => {
            const grid = el as HTMLElement;
            const line = grid.querySelector('[data-testid="now-line"]') as HTMLElement;
            return {
                scrollTop: grid.scrollTop,
                // グリッドの上端から見た「いま」の線の位置
                offset: line.getBoundingClientRect().top - grid.getBoundingClientRect().top,
                height: grid.clientHeight,
            };
        });
        expect(view.scrollTop).toBeGreaterThan(0);
        expect(view.offset).toBeGreaterThan(0);
        expect(view.offset).toBeLessThan(view.height / 2);

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
        await goto(page, '/');

        // 照合は録画の数だけファイルを見に行くので実機では数秒かかる。
        // その間に二度押しできないことを確かめたいので遅らせる
        await page.route('**/?/reconcile', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await route.continue();
        });

        const button = page.getByTestId('reconcile-button');
        await button.click();

        await expect(button).toBeDisabled();
        await expect(page.getByTestId('loading-bar')).toHaveAttribute('data-loading', 'true');

        await expect(page.getByTestId('reconcile-result')).toBeVisible();
        await expect(button).toBeEnabled();
        await expect(page.getByTestId('loading-bar')).not.toHaveAttribute('data-loading', 'true');

        /*
         * 知らせは右下に浮いていて、自分で閉じられる。
         * 本文の上に差し込んでいた頃は、出た分だけ表が下へずれていた
         */
        await page.getByTestId('reconcile-result-close').click();
        await expect(page.getByTestId('reconcile-result')).toHaveCount(0);
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

        // 実体と照合すると recordings が飛ぶ
        await page.getByTestId('reconcile-button').click();

        await expect
            .poll(async () => await page.evaluate(() => (window as unknown as { seen: string[] }).seen))
            .toContain('recordings');
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
