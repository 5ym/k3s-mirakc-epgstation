import { fail } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import {
    allowDeletion,
    issueApiKey,
    enabled as jellyfinEnabled,
    registerLiveTv,
    setupLibrary,
} from '$lib/server/jellyfin';
import { isStored, saveSettings, settings } from '$lib/server/settings';

export function load({ url }) {
    const current = settings();
    return {
        jellyfinUrl: current.jellyfinUrl,
        // 鍵そのものは返さない。設定済みかどうかだけ分かればよい
        hasApiKey: current.jellyfinApiKey !== '',
        fromEnv: {
            url: !isStored('jellyfinUrl') && config.jellyfinUrl !== '',
            apiKey: !isStored('jellyfinApiKey') && config.jellyfinApiKey !== '',
        },
        enabled: jellyfinEnabled(),
        libraryDir: config.libraryDir,
        // Jellyfin から見た denpa のURL。M3U に書き込まれる
        iptvOrigin: config.iptvOrigin === '' ? url.origin : config.iptvOrigin,
        liveProfile: config.liveProfile,
    };
}

export const actions = {
    /** APIキーを直接貼る場合 */
    save: async ({ request }) => {
        const form = await request.formData();
        const jellyfinUrl = String(form.get('jellyfinUrl') ?? '').trim();
        const jellyfinApiKey = String(form.get('jellyfinApiKey') ?? '').trim();
        if (jellyfinUrl === '') return fail(400, { message: 'Jellyfin のURLを入力してください' });

        // 空欄のときは既存の鍵を消さない(URLだけ直したい場合があるため)
        saveSettings(jellyfinApiKey === '' ? { jellyfinUrl } : { jellyfinUrl, jellyfinApiKey });
        return { success: true, saved: true };
    },

    /**
     * 管理者のIDとパスワードからAPIキーを発行する。
     * APIキーは Jellyfin のセットアップ後にしか作れないので、こちらが普通の入口になる。
     */
    issue: async ({ request }) => {
        const form = await request.formData();
        const jellyfinUrl = String(form.get('jellyfinUrl') ?? '').trim();
        const username = String(form.get('username') ?? '').trim();
        const password = String(form.get('password') ?? '');
        if (jellyfinUrl === '' || username === '') {
            return fail(400, { message: 'URLと管理者IDを入力してください' });
        }

        try {
            const key = await issueApiKey(jellyfinUrl, username, password);
            // パスワードは保存しない。発行された鍵だけ残す
            saveSettings({ jellyfinUrl, jellyfinApiKey: key });
            return { success: true, issued: true };
        } catch (error) {
            return fail(400, { message: String(error instanceof Error ? error.message : error) });
        }
    },

    /** ライブラリ・メタデータ・削除許可・ライブTV をまとめて設定する */
    setup: async ({ url }) => {
        if (!jellyfinEnabled())
            return fail(400, { message: '先に Jellyfin のURLとAPIキーを設定してください' });
        const origin = config.iptvOrigin === '' ? url.origin : config.iptvOrigin;

        try {
            const library = await setupLibrary(config.libraryDir);
            const granted = await allowDeletion();
            const liveTv = await registerLiveTv(origin, config.liveProfile);
            return { success: true, setup: { library, granted, liveTv } };
        } catch (error) {
            return fail(502, { message: `Jellyfin の設定に失敗しました: ${error}` });
        }
    },
};
