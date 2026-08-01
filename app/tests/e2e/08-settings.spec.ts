import { expect, test } from '@playwright/test';
import { JELLYFIN_URL } from '../../playwright.config';
import { goto } from './helpers';

/**
 * Jellyfin との接続設定。
 *
 * APIキーは Jellyfin のセットアップを終えてからでないと発行できないので、
 * 「denpa を動かす前に用意しておく」ことができない。管理者のIDとパスワードから
 * denpa が発行して保存する、というのがここでの本筋。
 */
test.describe('設定', () => {
    test.beforeEach(async ({ request }) => {
        await request.post(`${JELLYFIN_URL}/__control/reset`);
    });

    test('管理者のID/パスワードからAPIキーを発行して保存できる', async ({ page }) => {
        await goto(page, '/settings');

        await page.getByTestId('jellyfin-url').fill(JELLYFIN_URL);
        await page.getByTestId('jellyfin-user').fill('admin');
        await page.getByTestId('jellyfin-password').fill('denpa-dev');
        await page.getByTestId('issue-key').click();

        await expect(page.getByTestId('issued-result')).toContainText('パスワードは保存していません');
        await expect(page.getByTestId('jellyfin-state')).toHaveText('連携済み');
        // 画面から入れたものであることが分かるようにしておく
        await expect(page.getByTestId('key-source')).toContainText('この画面で設定');
    });

    test('パスワードが違えば理由を出して保存しない', async ({ page }) => {
        await goto(page, '/settings');
        await page.getByTestId('jellyfin-url').fill(JELLYFIN_URL);
        await page.getByTestId('jellyfin-user').fill('admin');
        await page.getByTestId('jellyfin-password').fill('wrong');
        await page.getByTestId('issue-key').click();

        await expect(page.getByTestId('settings-error')).toContainText('ログインに失敗しました');
    });

    test('Jellyfin 側のライブラリと削除許可をまとめて設定できる', async ({ page, request }) => {
        await goto(page, '/settings');
        await page.getByTestId('jellyfin-url').fill(JELLYFIN_URL);
        await page.getByTestId('jellyfin-user').fill('admin');
        await page.getByTestId('jellyfin-password').fill('denpa-dev');
        await page.getByTestId('issue-key').click();
        await expect(page.getByTestId('jellyfin-state')).toHaveText('連携済み');

        await page.getByTestId('run-setup').click();
        const result = page.getByTestId('setup-result');
        await expect(result).toContainText('を追加しました');
        await expect(result).toContainText('admin');

        const state = await (await request.get(`${JELLYFIN_URL}/__control/state`)).json();

        // 日本の番組は TheTVDB に載っていないので、.nfo を読ませてネット取得は切る
        expect(state.folders).toHaveLength(1);
        // ライブTVのタイルと並ぶので、中身が分かる名前にしてある
        expect(state.folders[0].Name).toBe('録画');
        expect(state.folders[0].CollectionType).toBe('tvshows');
        expect(state.folders[0].LibraryOptions.MetadataSavers).toEqual(['Nfo']);
        expect(state.folders[0].LibraryOptions.EnableInternetProviders).toBe(false);
        for (const type of state.folders[0].LibraryOptions.TypeOptions) {
            expect(type.MetadataFetchers).toEqual([]);
            expect(type.ImageFetchers).toEqual([]);
        }

        // 削除は管理者だけに許可する。全員に配ると事故る
        const admin = state.users.find((u: { Name: string }) => u.Name === 'admin');
        const guest = state.users.find((u: { Name: string }) => u.Name === 'guest');
        expect(admin.Policy.EnableContentDeletion).toBe(true);
        expect(guest.Policy.EnableContentDeletion).toBe(false);
    });

    test('2回セットアップしても重複しない', async ({ page, request }) => {
        await goto(page, '/settings');
        await page.getByTestId('jellyfin-url').fill(JELLYFIN_URL);
        await page.getByTestId('jellyfin-user').fill('admin');
        await page.getByTestId('jellyfin-password').fill('denpa-dev');
        await page.getByTestId('issue-key').click();

        await page.getByTestId('run-setup').click();
        await expect(page.getByTestId('setup-result')).toContainText('を追加しました');
        await page.getByTestId('run-setup').click();
        await expect(page.getByTestId('setup-result')).toContainText('既存のまま更新');

        const state = await (await request.get(`${JELLYFIN_URL}/__control/state`)).json();
        expect(state.folders).toHaveLength(1);
    });
});
