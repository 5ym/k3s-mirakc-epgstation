import { fail } from '@sveltejs/kit';
import { isCmMode } from '$lib/server/cm';
import { database, now, queryAll, queryOne } from '$lib/server/db';
import { isVideoCodec } from '$lib/server/encoder';
import { available as migrateAvailable, source, start, status } from '$lib/server/migrate';
import { saveSettings, settings } from '$lib/server/settings';
import { send, type Webhook } from '$lib/server/webhook';
import { EVENTS } from '$lib/webhook-events';

/**
 * ベーシック認証のユーザー名。**画面からは変えられない。**
 *
 * 変えて嬉しいことが何も無い。プレイヤー側にも同じものを入れる必要があるだけで、
 * 忘れると登録済みの端末が全部つながらなくなる。
 */
const BASIC_AUTH_USER = 'denpa';

/*
 * パスワードに使う文字。
 *
 * 記号は入れない。このパスワードは**再生リンクのURLに埋め込まれる**ので、
 * `:` `@` `/` `#` `?` が入ると URL として割れてしまう。
 * 紛らわしい文字 (0/O、1/l/I) も外す。Kodi の画面で手入力することがある
 */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 24;

function generatePassword(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_LENGTH));
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function load() {
    const current = settings();
    return {
        recording: current,
        auth: {
            user: current.basicAuthUser,
            /*
             * パスワードそのものを返す。
             *
             * Kodi や VLC に登録するときに必要になるが、覚えていないと入れ直すしかなく、
             * 入れ直せば既に登録した端末が全部つながらなくなる。
             *
             * 隠す意味も薄い。範囲が files なら録画一覧の再生リンクに同じものが
             * 埋まっている (画面を開ければ見える)。範囲が all ならこの画面自体に
             * 認証がかかっているので、見えている時点で持っている人
             */
            password: current.basicAuthPassword,
            scope: current.basicAuthScope,
        },
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
     * ベーシック認証。VLC も Kodi もリダイレクト型の認証を扱えないので、
     * ファイルを取りに来る口だけにかけられるようにしてある。
     */
    saveAuth: async ({ request }) => {
        const form = await request.formData();
        const scope = String(form.get('basicAuthScope') ?? 'files');
        if (scope !== 'files' && scope !== 'all') {
            return fail(400, { message: '適用範囲の指定が不正です' });
        }
        // ユーザー名は denpa 固定 (画面から変えられない)。
        // 画面にはいま入っているパスワードが出ているので、空にしたのは「消したい」ということ
        saveSettings({
            basicAuthUser: BASIC_AUTH_USER,
            basicAuthPassword: String(form.get('basicAuthPassword') ?? ''),
            basicAuthScope: scope,
        });
        return { success: true, saved: true };
    },

    /**
     * パスワードを作り直して、そのまま保存する。
     *
     * 考えて決めるものではないし、入れたのに保存を忘れると
     * 「掛けたつもりで掛かっていない」になる。1回の操作で終わらせる。
     */
    newPassword: () => {
        saveSettings({ basicAuthUser: BASIC_AUTH_USER, basicAuthPassword: generatePassword() });
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
        saveSettings({
            codec,
            cmCut,
            cmDetector: form.get('cmDetector') === 'silence' ? 'silence' : 'jls',
            encode: form.get('encode') === 'on',
            keepOriginal: form.get('keepOriginal') === 'on',
            freeOnly: form.get('freeOnly') === 'on',
        });
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
            // name は廃止したが、既存DBの列が NOT NULL のままなので空文字を入れる。
            // CREATE TABLE IF NOT EXISTS では列定義が変わらないため
            .prepare('INSERT INTO webhooks (name, url, events, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
            .run('', url, JSON.stringify(events), now());
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
