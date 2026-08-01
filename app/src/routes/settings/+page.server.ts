import { fail } from '@sveltejs/kit';
import { isCmMode } from '$lib/server/cm';
import { config } from '$lib/server/config';
import { database, now, queryAll, queryOne } from '$lib/server/db';
import { isVideoCodec } from '$lib/server/encoder';
import { available as migrateAvailable, source, start, status } from '$lib/server/migrate';
import { isStored, saveSettings, settings } from '$lib/server/settings';
import { send, type Webhook } from '$lib/server/webhook';
import { EVENTS } from '$lib/webhook-events';

export function load() {
    const current = settings();
    return {
        recording: current,
        auth: {
            user: current.basicAuthUser,
            // パスワードそのものは返さない。設定済みかどうかだけ分かればよい
            hasPassword: current.basicAuthPassword !== '',
            scope: current.basicAuthScope,
            fromEnv: !isStored('basicAuthPassword') && config.basicAuthPassword !== '',
        },
        fromEnv: { codec: !isStored('codec'), cmCut: !isStored('cmCut') },
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
    /**
     * ベーシック認証。mpv も Kodi もリダイレクト型の認証を扱えないので、
     * ファイルを取りに来る口だけにかけられるようにしてある。
     */
    saveAuth: async ({ request }) => {
        const form = await request.formData();
        const user = String(form.get('basicAuthUser') ?? '').trim();
        const password = String(form.get('basicAuthPassword') ?? '');
        const scope = String(form.get('basicAuthScope') ?? 'files');
        if (scope !== 'files' && scope !== 'all') {
            return fail(400, { message: '適用範囲の指定が不正です' });
        }
        if (user !== '' && password === '' && settings().basicAuthPassword === '') {
            return fail(400, { message: 'パスワードを入力してください' });
        }
        // パスワード欄が空なら今のものを変えない(URLだけ直したいことがある)
        saveSettings(
            password === ''
                ? { basicAuthUser: user, basicAuthScope: scope }
                : { basicAuthUser: user, basicAuthPassword: password, basicAuthScope: scope },
        );
        return { success: true, saved: true };
    },

    /** 録画のしかた。番組ごとに変えたくなることが実際にはほとんど無いので全体で1つ */
    saveRecording: async ({ request }) => {
        const form = await request.formData();
        const codec = String(form.get('codec') ?? '');
        const cmCut = String(form.get('cmCut') ?? '');
        if (!isVideoCodec(codec) || !isCmMode(cmCut)) {
            return fail(400, { message: 'コーデックかCMの指定が不正です' });
        }
        saveSettings({ codec, cmCut });
        return { success: true, saved: true };
    },

    addWebhook: async ({ request }) => {
        const form = await request.formData();
        const url = String(form.get('url') ?? '').trim();
        if (!/^https?:\/\//.test(url)) {
            return fail(400, { message: 'http(s) で始まるURLを入力してください' });
        }
        // 何も選ばなければ全部の通知を受け取る
        const events = form.getAll('events').map(String).filter(Boolean);

        database()
            .prepare('INSERT INTO webhooks (url, events, enabled, created_at) VALUES (?, ?, 1, ?)')
            .run(url, JSON.stringify(events), now());
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
