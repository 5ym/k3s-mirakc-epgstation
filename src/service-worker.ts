/// <reference lib="webworker" />

/**
 * ホーム画面から開けるようにするための最小限のサービスワーカー。
 *
 * 録画一覧も番組表も**サーバの今の状態**が要るので、中身はキャッシュしない。
 * 古い一覧を見せるくらいなら、繋がらないと分かるほうがまし。
 * ここで持つのはアプリの殻(JS/CSS/アイコン)だけで、これが無いと
 * オフラインのとき真っ白なブラウザのエラー画面になる。
 */

import { build, files, version } from '$service-worker';

const CACHE = `denpa-${version}`;
/** 殻だけ。ロゴやサムネイルのような「増えるもの」は入れない */
const SHELL = [...build, ...files.filter((file) => !file.endsWith('robots.txt'))];

const worker = self as unknown as ServiceWorkerGlobalScope;

worker.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
    void worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
    // 版が変われば古い殻は用済み
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => worker.clients.claim()),
    );
});

worker.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== location.origin) return;
    /*
     * API は素通しする。録画の配信は数十GB、通知は繋ぎっぱなしの SSE で、
     * どちらもキャッシュに載せると壊れる
     */
    if (url.pathname.startsWith('/api/')) return;

    event.respondWith(
        caches.match(request).then((hit) => {
            // 殻はキャッシュから。それ以外は毎回サーバに聞く
            return hit ?? fetch(request);
        }),
    );
});
