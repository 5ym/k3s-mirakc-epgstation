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

export interface Cell {
    programId: string;
    serviceId: string;
    startAt: number;
}

/**
 * 番組表に出ているうち、これから始まるものを放送順に返す。
 *
 * グリッドは日本の慣習どおり4時から24時間ぶんを出すので、先頭は「もう終わった番組」。
 * 位置で選ぶと過去の番組を予約してしまい、いつまでも録画が始まらない。
 */
async function allCells(page: Page): Promise<Cell[]> {
    return await page.getByTestId('grid-program').evaluateAll((nodes) =>
        nodes.map((node) => ({
            programId: node.getAttribute('data-program-id') ?? '',
            serviceId: node.getAttribute('data-service-id') ?? '',
            startAt: Number(node.getAttribute('data-start-at')),
        })),
    );
}

async function cellsOn(page: Page): Promise<Cell[]> {
    return (await allCells(page))
        .filter((c) => c.startAt > Date.now())
        .sort((a, b) => a.startAt - b.startAt || Number(a.serviceId) - Number(b.serviceId));
}

/** 番組表に出ているうち、もう終わったもの。放送日の頭(4時台)では前日に送って探す */
export async function past(page: Page): Promise<Cell[]> {
    const stale = (cells: Cell[]) => cells.filter((c) => c.startAt < Date.now() - 60 * 60 * 1000);
    let found = stale(await allCells(page));
    if (found.length === 0) {
        await page.getByTestId('prev-day').click();
        await page.locator('[data-hydrated="true"]').waitFor();
        found = stale(await allCells(page));
    }
    expect(found.length).toBeGreaterThan(0);
    return found;
}

export async function upcoming(page: Page): Promise<Cell[]> {
    let soon = await cellsOn(page);
    if (soon.length === 0) {
        // 放送日の終わり際(深夜3時台など)は、この日にこれから始まる番組が
        // 1つも残っていない。翌日に送って探す
        await page.getByTestId('next-day').click();
        await page.locator('[data-hydrated="true"]').waitFor();
        soon = await cellsOn(page);
    }
    expect(soon.length).toBeGreaterThan(0);
    return soon;
}

/** 番組表のマスをIDで掴む。番組が終わると並びがずれるので位置では追わない */
export function cellOf(page: Page, programId: string) {
    return page.locator(`[data-testid="grid-program"][data-program-id="${programId}"]`);
}

/**
 * 指定した局の「少し先の番組」を予約する。
 *
 * BSの偽番組は10秒しかなく、番組表のグリッドではマスが潰れて押せない。
 * ここで見たいのは録画そのものなので、予約は画面ではなくアクションに直接投げる。
 */
export async function reserveSoon(
    page: Page,
    request: APIRequestContext,
    type: string,
    skip = 0,
    /** 録画のしかた。画面のチェックボックスと同じキーを渡す */
    options: Record<string, string> = {},
) {
    await goto(page, `/guide?type=${type}`);
    const cells = await upcoming(page);
    const target = cells[Math.min(skip, cells.length - 1)];
    // options=1 は「画面のフォームから来た」印。無いと既定のまま扱われる
    const form =
        Object.keys(options).length === 0
            ? { programId: target.programId }
            : { programId: target.programId, options: '1', ...options };
    const res = await request.post('/guide?/reserve', { form });
    expect(res.ok()).toBeTruthy();
    return target.programId;
}
