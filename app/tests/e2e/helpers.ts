import { type APIRequestContext, expect, type Page } from '@playwright/test';

/**
 * ページを開いてハイドレーション完了まで待つ。
 * SSR済みのDOMにいきなり入力すると、その後のハイドレーションで値が初期値に戻り、
 * 空のまま絞り込みが実行されてしまう。フォームを触るテストは必ずこれを使う。
 */
export async function goto(page: Page, url: string): Promise<void> {
    await page.goto(url);
    await page.locator('[data-hydrated="true"]').waitFor();
}

/** EPG を取り込む。定期取得は止めてあるので、テストは必ずこれを先に呼ぶ */
export async function syncEpg(request: APIRequestContext): Promise<void> {
    const res = await request.post('/api/sync');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.services).toBeGreaterThan(0);
    expect(body.programs).toBeGreaterThan(0);
}
