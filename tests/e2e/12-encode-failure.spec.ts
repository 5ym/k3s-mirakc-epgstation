import { existsSync, rmSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, goto, reserveSoon, syncEpg, test } from './helpers';

/** 状態が変わるのを待つ。画面は知らせで自分で書き換わるので、開き直さない */
async function waitForRow(page: Page, selector: string, expected: string, timeoutMs = 90_000) {
    await goto(page, '/');
    await expect(page.locator(selector).first()).toContainText(expected, { timeout: timeoutMs });
}

/**
 * エンコードが失敗したときの見え方と後始末。
 * 失敗の表示が消せないと、直したあとも延々と残って邪魔になる。
 */
test.describe('エンコードの失敗', () => {
    test.afterAll(({ stack }) => {
        if (existsSync(stack.failFile)) rmSync(stack.failFile);
    });

    test('失敗したエンコードは録画の行に出て、理由は詳細で見られる', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // ここから先のエンコードを失敗させる
        writeFileSync(stack.failFile, '1');

        await reserveSoon(page, request, 'BS');

        // 失敗したものは進み具合を出さない。状態と理由だけが行に残る
        await waitForRow(page, '[data-testid="recording-row"] [data-testid="recording-state"]', '失敗');
        await goto(page, '/');
        await expect(page.getByTestId('encode-progress')).toHaveCount(0);
        const failed = page
            .getByTestId('recording-row')
            .filter({ has: page.getByTestId('recording-error') })
            .first();
        await expect(failed.getByTestId('recording-state')).toHaveText('失敗');
        await expect(failed.getByTestId('recording-error')).toContainText('エンコードに失敗しました');

        // 理由は行を押して詳細で見る。ffmpeg の出力は長いので一覧には貼らない
        await failed.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        await expect(detail.getByTestId('detail-error')).toContainText('Error initializing the encoder');
        // 警告に埋もれず、止まった理由だけが出ていること
        await expect(detail.getByTestId('detail-error')).not.toContainText(
            'has not been used for any stream',
        );
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);

        // 削除は2回押させる。1回目は聞き返すだけで、まだ消えない
        await failed.getByTestId('delete-button').click();
        await expect(failed.getByTestId('delete-confirm')).toBeVisible();
        await expect(failed).toHaveCount(1);

        const id = await failed.getAttribute('data-recording-id');
        await failed.getByTestId('delete-confirm').click();
        await expect(page.locator(`[data-recording-id="${id}"]`)).toHaveCount(0);

        rmSync(stack.failFile);
    });
});
