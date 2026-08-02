import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { MIRAKURUN_URL, TEST_ROOT } from '../../playwright.config';
import { goto, reserveSoon, syncEpg } from './helpers';

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
 * 代わりにエンコードの前に見て、掛かったままなら Mirakurun 側に頼んで解く
 * (カードを読めるのはあちらのコンテナだけ)。
 */
test.describe('スクランブルされたまま録れたとき', () => {
    test.afterEach(async ({ request }) => {
        await request.post(`${MIRAKURUN_URL}/__control/scrambled?on=0`);
    });

    test('録画は止めず、エンコードの前に自動で解除する', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // カードが読めていない状態にする
        await request.post(`${MIRAKURUN_URL}/__control/scrambled?on=1`);

        const programId = await reserveSoon(page, request, 'BS');
        const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;

        // 録画自体は失敗しない。解除まで済んで視聴可能になる
        await expect(async () => {
            await goto(page, '/');
            await expect(page.locator(row).getByTestId('recording-state')).toHaveText('視聴可能');
        }).toPass({ timeout: 120_000 });

        await expect(page.locator(row).getByTestId('recording-error')).toHaveCount(0);
    });

    test('生TSを残す設定なら、残るのは解除済みのTSだけ', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);
        await request.post(`${MIRAKURUN_URL}/__control/scrambled?on=1`);

        const programId = await reserveSoon(page, request, 'BS', 0, { encode: 'on', keepOriginal: 'on' });
        const row = `[data-testid="recording-row"][data-program-id="${programId}"]`;

        await expect(async () => {
            await goto(page, '/');
            await expect(page.locator(row).getByTestId('recording-state')).toHaveText('視聴可能');
        }).toPass({ timeout: 120_000 });

        // 掛かったままのTSを取っておいても、あとから解ける保証は無いので置き換える
        expect(scrambledFiles(`${TEST_ROOT}/recorded`)).toEqual([]);
    });
});
