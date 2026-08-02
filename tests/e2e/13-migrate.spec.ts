import { mkdirSync, rmSync } from 'node:fs';
import { expect, goto, test } from './helpers';

/**
 * EPGStation からの引き継ぎ。
 *
 * 実際の取り込みは EPGStation の MariaDB と数百GBの録画が要るので、ここでは
 * 「PVCをマウントし忘れたときに止まること」と「裏で走って結果が画面に出ること」を見る。
 * ファイルの置き場所と .nfo の中身は録画の通しテスト(03)と同じ処理を通る。
 *
 * Playwright と アプリは同じコンテナで動くので、マウントの有無はディレクトリを
 * 作る/消すで再現できる。
 */
test.describe('EPGStation からの引き継ぎ', () => {
    test.beforeEach(({ stack }) => {
        rmSync(stack.epgstationDir, { recursive: true, force: true });
    });

    test('引き継ぎ元が見えなければ実行させない', async ({ page }) => {
        await goto(page, '/settings');

        await expect(page.getByTestId('migrate-unavailable')).toBeVisible();
        // ボタンを出しておいて押したら失敗、では何をすればいいか分からない
        await expect(page.getByTestId('migrate-run')).toHaveCount(0);
    });

    test('引き継ぎ元が見えれば実行でき、失敗すれば理由が出る', async ({ page, stack }) => {
        mkdirSync(stack.epgstationDir, { recursive: true });
        await goto(page, '/settings');
        await expect(page.getByTestId('migrate-unavailable')).toHaveCount(0);

        // 既定は下見。チェックを入れない限りファイルもDBも触らない
        await expect(page.getByTestId('migrate-apply')).not.toBeChecked();
        await page.getByTestId('migrate-run').click();
        await expect(page.getByTestId('migrate-started')).toBeVisible();

        // EPGStation のDBは居ないので失敗する。SSE で結果が降ってくる
        const progress = page.getByTestId('migrate-progress');
        await expect(progress).toHaveAttribute('data-state', 'failed');
        await expect(page.getByTestId('migrate-state')).toHaveText('失敗');
        // 何が起きたのかが画面に出ること。文面は繋がらなかった理由 (拒否/時間切れ)
        // 次第で変わるので、宛先や語句までは決め打たない
        await expect(page.getByTestId('migrate-error')).toContainText(/Error/);
        // 何をしようとしたのかが残る
        await expect(page.getByTestId('migrate-log')).toContainText('失敗');
    });
});
