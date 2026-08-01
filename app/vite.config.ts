import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [tailwindcss(), sveltekit()],
    server: {
        // compose 上の Jellyfin はサービス名(`http://app:5173`)で開発サーバを叩く。
        // vite の Host チェックに引っかかるので開発時だけ外す(本番は adapter-node で
        // 動かすため、この設定は使われない)
        allowedHosts: true,
    },
    // bun:sqlite などの bun 組み込みモジュールは bundle させずランタイム解決に回す
    // (vite が解決しようとして "failed to resolve" になるため)
    ssr: {
        external: ['bun:sqlite', 'bun:test'],
    },
    build: {
        rollupOptions: {
            external: [/^bun:/],
        },
    },
    optimizeDeps: {
        exclude: ['bun:sqlite'],
    },
});
