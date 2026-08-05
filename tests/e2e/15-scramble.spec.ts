import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, goto, reserveSoon, setRecording, syncEpg, test } from './helpers';

/** 残っているTSのうち、スクランブルが掛かったままのもの */
function scrambledFiles(dir: string): string[] {
    return readdirSync(dir)
        .filter((name) => name.endsWith('.ts'))
        .filter((name) => {
            const buffer = readFileSync(join(dir, name));
            for (let i = 0; i + 188 <= buffer.length; i += 188) {
                if (buffer[i] !== 0x47) return false;
                if ((buffer[i + 3] & 0xc0) !== 0) return true;
            }
            return false;
        });
}

/**
 * カードが読めていない状態で録れてしまったTSの扱い。
 *
 * 電波は二度と戻ってこないので、スクランブルされたままでも録画は止めない。
 * 代わりにエンコードの前に見て、掛かったままならエージェントに頼んで解く
 * (カードを読めるのはあちらのコンテナだけ)。
 */
test.describe('スクランブルされたまま録れたとき', () => {
    test.afterEach(async ({ request, stack }) => {
        await request.post(`${stack.agentUrl}/__control/scrambled?on=0`);
    });

    test('録画は止めず、エンコードの前に自動で解除する', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // カードが読めていない状態にする
        await request.post(`${stack.agentUrl}/__control/scrambled?on=1`);

        const programId = await reserveSoon(page, request, 'BS');
        const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;

        // 録画自体は失敗しない。解除まで済んで視聴可能になる
        await expect(async () => {
            await goto(page, '/');
            await expect(page.locator(row).getByTestId('recording-state')).toHaveText('視聴可能');
        }).toPass({ timeout: 120_000 });

        // 失敗の理由は詳細にしか出ない。何も起きていないので1つも無いこと
        await page.locator(row).getByTestId('detail-button').click();
        await expect(page.getByTestId('program-detail')).toBeVisible();
        await expect(page.getByTestId('detail-error')).toHaveCount(0);
        await page.getByTestId('detail-close').click();
    });

    test('生TSを残す設定なら、残るのは解除済みのTSだけ', async ({ page, request, stack }) => {
        test.setTimeout(180_000);
        await syncEpg(request);
        await request.post(`${stack.agentUrl}/__control/scrambled?on=1`);

        await setRecording(request, { keepOriginal: true });
        try {
            const programId = await reserveSoon(page, request, 'BS');
            const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;

            await expect(async () => {
                await goto(page, '/');
                await expect(page.locator(row).getByTestId('recording-state')).toHaveText('視聴可能');
            }).toPass({ timeout: 120_000 });

            // 掛かったままのTSを取っておいても、あとから解ける保証は無いので置き換える
            expect(scrambledFiles(stack.recordedDir)).toEqual([]);

            /*
             * 生TSを残しているなら、その大きさも行に出す。
             * エンコード済みのぶんしか出していなかった頃は、消していいのか・
             * どれだけ空くのかが画面から分からなかった
             */
            await expect(page.locator(row).getByTestId('row-body')).toContainText('生TS');
        } finally {
            await setRecording(request);
        }
    });
});
