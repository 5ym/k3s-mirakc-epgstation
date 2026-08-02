import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { WEBHOOK_URL } from '../../playwright.config';
import { goto, reserveSoon, syncEpg, upcoming } from './helpers';

/**
 * 録画→エンコード→保存先に入るまでを通しで確認する。
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
    test('予約した番組が録画され、エンコードされて保存先に入る', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // 節目の通知が実際にどう飛ぶかも、この一連の流れで見ておく
        await request.post(`${WEBHOOK_URL}/__control/reset`);
        await goto(page, '/settings');
        await page.getByTestId('webhook-url').fill(`${WEBHOOK_URL}/__control/webhook`);
        await page.getByTestId('webhook-add').click();

        // BSは他のテストが触らないので、チューナー競合の心配なく録れる
        const programId = await reserveSoon(page, request, 'BS');

        const reservationRow = `[data-testid="reservation-row"][data-program-id="${programId}"]`;
        await waitForRowState(page, '/?all=1', reservationRow, 'reservation-state', '完了');

        const recordingRow = `[data-testid="recording-row"][data-program-id="${programId}"]`;
        await waitForRowState(page, '/', recordingRow, 'recording-state', '視聴可能');

        // 保存先のパスが決まっていること。実体との突き合わせにこのパスを使う。
        // 画面には出さない(普段は見ないので)ので、行の属性から取る
        await goto(page, '/');
        const recording = page.locator(recordingRow);
        const videoPath = (await recording.getAttribute('data-library-path')) ?? '';
        expect(videoPath).toContain('/tmp/denpa-e2e/library/');
        expect(videoPath).toContain('.mkv');

        // CM検出が走り、既定のチャプター付与として記録されていること。
        // どこを検出したかは一覧に出さず、行を押した詳細で見せる (長くて場所を食うため)
        await recording.locator('td').first().click();
        await expect(page.getByTestId('detail-cm')).toContainText('5:00-6:00');
        await page.getByTestId('detail-close').click();

        // 実際に録れた長さが記録されていること。番組表の尺は予定でしかなく、
        // 途中で止めたときは実物と合わない
        const recorded = Number(await recording.getAttribute('data-duration-ms'));
        expect(recorded).toBeGreaterThan(0);
        // 番組表の尺(BSの偽番組は10秒)から大きく外れていないこと
        expect(recorded).toBeLessThan(5 * 60_000);

        // .nfo を読むプレイヤー(Kodi など)向けに、サイドカーが揃っていること
        const base = videoPath.replace(/\.mkv$/, '');
        expect(existsSync(`${base}.nfo`)).toBe(true);
        expect(existsSync(`${base}-thumb.jpg`)).toBe(true);

        const nfo = readFileSync(`${base}.nfo`, 'utf8');
        expect(nfo).toContain('<episodedetails>');
        expect(nfo).toContain('<studio>BS11イレブン</studio>');
        expect(nfo).toContain('<aired>');

        // 外部プレイヤーに渡す再生リンクが出ていること
        await expect(recording.getByTestId('play-link').first()).toBeVisible();

        // 行を押すと番組表と同じ詳細が出る
        await recording.locator('td').first().click();
        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail.getByTestId('detail-video')).toBeVisible();
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);

        // ファイルは Range で取りに行ける。mpv も VLC もこれでシークするので、
        // 対応していないと全部落とし終わるまで早送りできない
        const id = await recording.getAttribute('data-recording-id');
        expect(id).toBeTruthy();
        const part = await request.get(`/api/recordings/${id}/file`, {
            headers: {
                Range: 'bytes=0-99',
                // ファイルの口はベーシック認証をかけてある
                Authorization: `Basic ${Buffer.from('denpa:ひみつ', 'utf8').toString('base64')}`,
            },
        });
        expect(part.status()).toBe(206);
        expect(part.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
        expect((await part.body()).byteLength).toBe(100);

        // ダウンロードのリンクは資格情報を URL に入れる。ブラウザは画面を開いた
        // ときの認証をダウンロードに引き継がないので、素のURLだと 401 になる
        const href = (await recording.getByTestId('download-link').getAttribute('href')) ?? '';
        expect(href).toContain('denpa:');
        expect(href).toContain('download=1');

        // 名前を付けないと「file」という拡張子の無いファイルとして落ちてくる
        const attached = await request.get(href);
        expect(attached.status()).toBe(200);
        const disposition = attached.headers()['content-disposition'] ?? '';
        expect(disposition).toMatch(/^attachment;/);
        expect(disposition).toContain('.mkv');

        // 節目ごとに通知が飛び、どれも番組名と一緒にチャンネル名が入っていること。
        // 番組名だけだと、どの局のものか通知を見ただけでは分からない
        const state = await (await request.get(`${WEBHOOK_URL}/__control/state`)).json();
        const events = state.webhookCalls.map((call: { event: string }) => call.event);
        expect(events).toContain('recording.started');
        expect(events).toContain('recording.finished');
        expect(events).toContain('encode.finished');
        for (const call of state.webhookCalls as { text: string; recording?: { service: string } }[]) {
            expect(call.text).toContain('BS11イレブン');
            expect(call.recording?.service).toBe('BS11イレブン');
        }

        // 後続のテストに通知先を持ち越さない
        await goto(page, '/settings');
        await page.getByTestId('webhook-delete').first().click();
    });
});

test.describe('CMの実カット', () => {
    test('CMを切っても字幕は残る', async ({ page, request }) => {
        test.setTimeout(180_000);
        await syncEpg(request);

        // CM の扱いは全体設定。実際に切る側にしてから録る
        await goto(page, '/settings');
        await page.getByTestId('global-cmcut').selectOption('cut');
        await page.getByTestId('save-recording').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();

        await goto(page, '/guide?type=BS');
        const cells = await upcoming(page);
        const target = cells[0];
        const res = await request.post('/guide?/reserve', {
            form: { programId: target.programId, options: '1', encode: 'on' },
        });
        expect(res.ok()).toBeTruthy();

        const recordingRow = `[data-testid="recording-row"][data-program-id="${target.programId}"]`;
        await waitForRowState(page, '/', recordingRow, 'recording-state', '視聴可能');

        await goto(page, '/');
        const recording = page.locator(recordingRow);
        await recording.locator('td').first().click();
        await expect(page.getByTestId('detail-cm')).toContainText('5:00-6:00');
        await page.getByTestId('detail-close').click();

        // 字幕はエンコードの前にTSを切ることで残している。
        // フィルタで切っていた頃は -sn で落とすしかなかった
        const videoPath = (await recording.getAttribute('data-library-path')) ?? '';
        expect(videoPath).toContain('.mkv');
        // 切るための作業ファイルは片付いていること
        expect(existsSync(`${videoPath.replace(/\.mkv$/, '')}.cut.ts`)).toBe(false);
    });
});
