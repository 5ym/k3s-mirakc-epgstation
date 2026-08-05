import { config } from './config';

/**
 * ホーム画面に置いたときの見た目 (PWA のマニフェスト)。
 *
 * **名前を来た名前ごとに変えられるようにしてある。** 同じ denpa を外向き
 * (`dp.doany.io`) と LAN 用 (`dp.l.doany.io`) の2つの名前で出していて、
 * 両方をホーム画面に置くと**アイコンも名前も同じものが2つ並ぶ**。
 * どちらを押せば家の中から繋がるほうなのか分からない。
 *
 * ブラウザは入れた時点のマニフェストを覚えるので、**入れ直すまで名前は
 * 変わりません** (Chrome は開き直したときに読み直して更新することがある)。
 */

/** 既定の名前。`PWA_NAMES` に載っていない名前で来たらこれ */
const DEFAULT_NAME = 'denpa';

/**
 * この名前で来たときの表示名。
 *
 * 書き方は `ホスト名=表示名` のカンマ区切り (`PWA_NAMES`)。
 * 大文字小文字は問わない。載っていなければ `denpa`。
 */
export function appName(hostname: string): string {
    const target = hostname.toLowerCase();
    for (const raw of config.pwaNames.split(',')) {
        const at = raw.indexOf('=');
        if (at < 0) continue;
        const host = raw.slice(0, at).trim().toLowerCase();
        const name = raw.slice(at + 1).trim();
        if (host === target && name !== '') return name;
    }
    return DEFAULT_NAME;
}

export function manifest(hostname: string): unknown {
    const name = appName(hostname);
    return {
        name,
        short_name: name,
        description: 'テレビを録って観るためのもの',
        lang: 'ja',
        /*
         * **`id` も名前ごとに分ける。** 既定は `start_url` なので、
         * どちらの名前で入れても同じ `/` になる。同じ端末に2つ置いたときに
         * 片方がもう片方の入れ直しとして扱われないよう、明示しておく
         */
        id: `/?host=${hostname.toLowerCase()}`,
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#1d232a',
        theme_color: '#1d232a',
        icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
        shortcuts: [
            { name: '番組表', url: '/guide' },
            { name: '予約と録画', url: '/' },
        ],
    };
}
