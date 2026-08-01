import type { SubmitFunction } from '@sveltejs/kit';
import { enhance } from '$app/forms';
import { begin, finish } from './busy.svelte';

/**
 * `use:enhance` の代わり。送信中はそのフォームのボタンを押せなくし、
 * 画面上部のローディングバーを出す。
 *
 * 素の enhance だと、EPG取得のように数秒かかるアクションでも見た目が変わらず、
 * 二度押し・三度押しできてしまう。
 */
export function submitting(node: HTMLFormElement, submit?: SubmitFunction) {
    return enhance(node, (input) => {
        const buttons = [...node.querySelectorAll('button')];
        begin();
        node.setAttribute('aria-busy', 'true');
        for (const button of buttons) button.disabled = true;

        const after = submit?.(input);

        return async (options) => {
            finish();
            node.removeAttribute('aria-busy');
            for (const button of buttons) button.disabled = false;

            if (typeof after === 'function') await after(options);
            else await options.update();
        };
    });
}
