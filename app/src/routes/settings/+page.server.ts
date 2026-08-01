import { fail } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { database, now, queryAll, queryOne } from '$lib/server/db';
import {
    allowDeletion,
    issueApiKey,
    enabled as jellyfinEnabled,
    registerLiveTv,
    setupLibrary,
} from '$lib/server/jellyfin';
import { available as migrateAvailable, source, start, status } from '$lib/server/migrate';
import { isStored, saveSettings, settings } from '$lib/server/settings';
import { send, type Webhook } from '$lib/server/webhook';
import { EVENTS } from '$lib/webhook-events';

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
        webhooks: queryAll<Webhook>('SELECT * FROM webhooks ORDER BY id'),
        events: EVENTS,
        migrate: {
            available: migrateAvailable(),
            source: source.recordedDir,
            status: status(),
        },
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

    addWebhook: async ({ request }) => {
        const form = await request.formData();
        const name = String(form.get('name') ?? '').trim();
        const url = String(form.get('url') ?? '').trim();
        if (name === '' || !/^https?:\/\//.test(url)) {
            return fail(400, { message: '名前と http(s) で始まるURLを入力してください' });
        }
        // 何も選ばなければ全部の通知を受け取る
        const events = form.getAll('events').map(String).filter(Boolean);

        database()
            .prepare('INSERT INTO webhooks (name, url, events, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
            .run(name, url, JSON.stringify(events), now());
        return { success: true, webhookAdded: true };
    },

    toggleWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        database().prepare('UPDATE webhooks SET enabled = 1 - enabled WHERE id = ?').run(id);
        return { success: true };
    },

    deleteWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        database().prepare('DELETE FROM webhooks WHERE id = ?').run(id);
        return { success: true };
    },

    testWebhook: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        const webhook = queryOne<Webhook>('SELECT * FROM webhooks WHERE id = ?', id);
        if (webhook === undefined) return fail(400, { message: '通知先が見つかりません' });

        const status = await send(webhook, {
            event: 'recording.finished',
            text: 'denpa からのテスト送信です',
        });
        return { success: true, tested: status };
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

    /**
     * EPGStation からの引き継ぎ。数百GBのコピーになるので開始だけ受けて裏で進める。
     * 進捗は SSE で降ってくる。
     */
    migrate: async ({ request }) => {
        const form = await request.formData();
        const options = { apply: form.get('apply') === 'on', move: form.get('move') === 'on' };
        const result = start(options);
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, migrate: result.message };
    },
};
