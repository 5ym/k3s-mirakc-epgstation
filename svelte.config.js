import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
    preprocess: vitePreprocess(),
    kit: {
        // adapter-node の出力を `bun ./build/index.js` で動かす。bun 前提なので
        // サーバ側では bun:sqlite などの bun 組み込みモジュールをそのまま使える
        adapter: adapter(),
    },
};
