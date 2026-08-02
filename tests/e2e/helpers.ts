import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { expect, test } from '../stack';

export type { Stack } from '../stack';
// テストは必ずここから test / expect を取る。素の @playwright/test から取ると
// ワーカーごとのアプリ (tests/stack.ts) が立たず、宛先も決まらない
export { expect, test };

/**
 * ページを開いてハイドレーション完了まで待つ。
 * SSR済みのDOMにいきなり入力すると、その後のハイドレーションで値が初期値に戻り、
 * 空のまま絞り込みが実行されてしまう。フォームを触るテストは必ずこれを使う。
 */
export async function goto(page: Page, url: string): Promise<void> {
    await page.goto(url);
    await page.locator('[data-hydrated="true"]').waitFor();
}

/**
 * 投げた先が断ったときに、何を言われたのかまで出す。
 * 「false であるはず」とだけ出ても、状態番号も本文も分からず追いようがない
 */
async function ok(res: APIResponse, what: string): Promise<void> {
    if (res.ok()) return;
    throw new Error(`${what} が ${res.status()} で返しました: ${(await res.text()).slice(0, 500)}`);
}

/** EPG を取り込む。定期取得は止めてあるので、テストは必ずこれを先に呼ぶ */
export async function syncEpg(request: APIRequestContext): Promise<void> {
    const res = await request.post('/api/sync');
    await ok(res, 'EPG の取り込み');
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
export async function reserveSoon(page: Page, request: APIRequestContext, type: string, skip = 0) {
    await goto(page, `/guide?type=${type}`);
    const cells = await upcoming(page);
    const target = cells[Math.min(skip, cells.length - 1)];
    const res = await request.post('/guide?/reserve', { form: { programId: target.programId } });
    await ok(res, '予約');
    return target.programId;
}

/**
 * 1本録って、視聴可能になるまで待つ。
 *
 * 「外から消されたとき」や「WebDAV から消したとき」を試すには、実体のある録画が要る。
 * 以前は録画の通しテスト(03)が残した1本を借りていたが、ワーカーごとに別のアプリが
 * 立つようになったので、自分のぶんは自分で用意する
 */
export async function recordOne(
    page: Page,
    request: APIRequestContext,
): Promise<{ id: string; libraryPath: string }> {
    await syncEpg(request);
    // BS の偽番組は10秒。すぐ録り終わる
    const programId = await reserveSoon(page, request, 'BS');
    const row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);
    await expect(async () => {
        await goto(page, '/');
        await expect(row.getByTestId('recording-state')).toHaveText('視聴可能');
    }).toPass({ timeout: 120_000 });
    return {
        id: (await row.getAttribute('data-recording-id')) ?? '',
        libraryPath: (await row.getAttribute('data-library-path')) ?? '',
    };
}

/**
 * 録画のしかたを変える。全体で1つの設定なので、番組ごとの指定は無い。
 * 設定画面のフォームと同じものを投げる (チェックを外した状態はキーごと消える)
 */
export async function setRecording(
    request: APIRequestContext,
    patch: {
        codec?: string;
        cmCut?: string;
        cmDetector?: string;
        encode?: boolean;
        keepOriginal?: boolean;
        freeOnly?: boolean;
    } = {},
): Promise<void> {
    const form: Record<string, string> = {
        codec: patch.codec ?? 'av1',
        cmCut: patch.cmCut ?? 'chapter',
        // 偽 ffmpeg しか居ないので、外部のコマンドを呼ばないほうで固定する
        cmDetector: patch.cmDetector ?? 'silence',
    };
    if (patch.encode ?? true) form.encode = 'on';
    if (patch.keepOriginal === true) form.keepOriginal = 'on';
    if (patch.freeOnly ?? true) form.freeOnly = 'on';
    const res = await request.post('/settings?/saveRecording', { form });
    await ok(res, '録画のしかたの保存');
}
