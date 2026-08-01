import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { BS11 } from '../fake/services';
import { goto, syncEpg } from './helpers';

/**
 * 録画→エンコード→ライブラリ入りまでを通しで確認する。
 * 進行はサーバ側のタイマー任せなので、ページを読み直しながら状態が変わるのを待つ。
 */
async function waitForRowState(
    page: Page,
    url: string,
    selector: string,
    stateTestId: string,
    expected: string,
    timeoutMs = 90_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '(行なし)';
    while (Date.now() < deadline) {
        await goto(page, url);
        const badge = page.locator(selector).getByTestId(stateTestId).first();
        if ((await badge.count()) > 0) {
            last = ((await badge.textContent()) ?? '').trim();
            if (last === expected) return;
        }
        await page.waitForTimeout(1000);
    }
    throw new Error(`${selector} が「${expected}」にならなかった (最後の状態: ${last})`);
}

test.describe('録画とエンコード', () => {
    test('予約した番組が録画され、エンコードされてライブラリに入る', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // BSは他のテストが触らないので、チューナー競合の心配なく録れる
        await goto(page, `/guide?service=${BS11.id}`);

        // 少し先の枠(10秒番組)を予約する。番組が終わると行がずれるのでIDで固定する
        const programId = await page.getByTestId('program-row').nth(2).getAttribute('data-program-id');
        expect(programId).toBeTruthy();
        const row = page.locator(`[data-testid="program-row"][data-program-id="${programId}"]`);
        await row.getByTestId('reserve-button').click();
        await expect(row.getByTestId('reserve-button')).toHaveCount(0);

        const reservationRow = `[data-testid="reservation-row"][data-program-id="${programId}"]`;
        await waitForRowState(page, '/?all=1', reservationRow, 'reservation-state', '完了');

        const recordingRow = `[data-testid="recording-row"][data-program-id="${programId}"]`;
        await waitForRowState(page, '/recordings', recordingRow, 'recording-state', '視聴可能');

        // ライブラリ上のパスが決まっていること。Jellyfin はこのパスで突き合わせる
        await goto(page, '/recordings');
        const recording = page.locator(recordingRow);
        await expect(recording).toContainText('/tmp/denpa-e2e/library/');
        await expect(recording).toContainText('.mkv');

        // CM検出が走り、既定のチャプター付与として記録されていること
        await expect(recording.getByTestId('cm-info')).toContainText('CM チャプター');

        // Jellyfin が番組情報とサムネイルを読めるよう、サイドカーが揃っていること
        const videoPath = ((await recording.locator('span.font-mono').first().textContent()) ?? '').trim();
        const base = videoPath.replace(/\.mkv$/, '');
        expect(existsSync(`${base}.nfo`)).toBe(true);
        expect(existsSync(`${base}-thumb.jpg`)).toBe(true);

        const nfo = readFileSync(`${base}.nfo`, 'utf8');
        expect(nfo).toContain('<episodedetails>');
        expect(nfo).toContain('<studio>BS11イレブン</studio>');
        expect(nfo).toContain('<aired>');
    });
});
