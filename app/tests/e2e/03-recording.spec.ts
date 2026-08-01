import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { goto, reserveSoon, syncEpg } from './helpers';

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
        await page.waitForTimeout(250);
    }
    throw new Error(`${selector} が「${expected}」にならなかった (最後の状態: ${last})`);
}

test.describe('録画とエンコード', () => {
    test('予約した番組が録画され、エンコードされてライブラリに入る', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // BSは他のテストが触らないので、チューナー競合の心配なく録れる
        const programId = await reserveSoon(page, request, 'BS');

        const reservationRow = `[data-testid="reservation-row"][data-program-id="${programId}"]`;
        await waitForRowState(page, '/?all=1', reservationRow, 'reservation-state', '完了');

        const recordingRow = `[data-testid="recording-row"][data-program-id="${programId}"]`;
        await waitForRowState(page, '/recordings', recordingRow, 'recording-state', '視聴可能');

        // ライブラリ上のパスが決まっていること。実体との突き合わせにこのパスを使う
        await goto(page, '/recordings');
        const recording = page.locator(recordingRow);
        await expect(recording).toContainText('/tmp/denpa-e2e/library/');
        await expect(recording).toContainText('.mkv');

        // CM検出が走り、既定のチャプター付与として記録されていること
        await expect(recording.getByTestId('cm-info')).toContainText('CM チャプター');

        // .nfo を読むプレイヤー(Kodi など)向けに、サイドカーが揃っていること
        const videoPath = ((await recording.locator('span.font-mono').first().textContent()) ?? '').trim();
        const base = videoPath.replace(/\.mkv$/, '');
        expect(existsSync(`${base}.nfo`)).toBe(true);
        expect(existsSync(`${base}-thumb.jpg`)).toBe(true);

        const nfo = readFileSync(`${base}.nfo`, 'utf8');
        expect(nfo).toContain('<episodedetails>');
        expect(nfo).toContain('<studio>BS11イレブン</studio>');
        expect(nfo).toContain('<aired>');

        // 外部プレイヤーに渡す再生リンクが出ていること
        await expect(recording.getByTestId('play-link').first()).toBeVisible();

        // ファイルは Range で取りに行ける。mpv も VLC もこれでシークするので、
        // 対応していないと全部落とし終わるまで早送りできない
        const id = await recording.getAttribute('data-recording-id');
        expect(id).toBeTruthy();
        const part = await request.get(`/api/recordings/${id}/file`, {
            headers: { Range: 'bytes=0-99' },
        });
        expect(part.status()).toBe(206);
        expect(part.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
        expect((await part.body()).byteLength).toBe(100);
    });
});
