import { config } from './config';
import { database, now, queryOne } from './db';

/**
 * 画面から変えられる設定。
 *
 * Jellyfin のURLとAPIキーは、denpa を動かす前に用意しておくことが現実的でない
 * (APIキーは Jellyfin のセットアップを終えてからでないと発行できない)ため、
 * 環境変数ではなくDBに置いて画面から入れられるようにしている。
 *
 * 環境変数は初期値として扱う。DBに値があればそちらが勝つので、k8s の Secret を
 * 使いたい場合は今までどおり env で渡せばよい。
 */

export interface Settings {
    jellyfinUrl: string;
    jellyfinApiKey: string;
}

const DEFAULTS: () => Settings = () => ({
    jellyfinUrl: config.jellyfinUrl,
    jellyfinApiKey: config.jellyfinApiKey,
});

function stored(key: string): string | undefined {
    return queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}

export function settings(): Settings {
    const defaults = DEFAULTS();
    return {
        jellyfinUrl: (stored('jellyfinUrl') ?? defaults.jellyfinUrl).replace(/\/+$/, ''),
        jellyfinApiKey: stored('jellyfinApiKey') ?? defaults.jellyfinApiKey,
    };
}

export function saveSettings(patch: Partial<Settings>): Settings {
    const upsert = database().prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const at = now();
    const tx = database().transaction(() => {
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            upsert.run(key, String(value), at);
        }
    });
    tx();
    return settings();
}

/** その設定が環境変数から来ているのか、画面で入れたものなのかを表示するため */
export function isStored(key: keyof Settings): boolean {
    return stored(key) !== undefined;
}
