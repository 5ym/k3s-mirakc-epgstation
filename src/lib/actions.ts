import type { SubmitFunction } from '@sveltejs/kit';
import { tick } from 'svelte';
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
            try {
                // 先にバーを消すと、消えてから一拍おいて画面が変わる。
                // 新しい内容が描き終わるまで出したままにする
                if (typeof after === 'function') await after(options);
                else await options.update();
                await tick();
            } finally {
                finish();
                node.removeAttribute('aria-busy');
                for (const button of buttons) button.disabled = false;
            }
        };
    });
}

/**
 * 掴んで動かせるスクロール。番組表は縦横どちらにも長いので、
 * スクロールバーを掴まずに動かせるほうが早い。
 *
 * 少し動かしただけならクリック扱いにする(番組を開くため)。
 * それ以上動いたらドラッグとみなし、離したときのクリックは無効にする。
 */
export function dragScroll(node: HTMLElement) {
    const THRESHOLD = 5;
    let active = false;
    let dragged = false;
    let startX = 0;
    let startY = 0;
    let fromLeft = 0;
    let fromTop = 0;

    const down = (event: PointerEvent) => {
        if (event.button !== 0) return;
        active = true;
        dragged = false;
        startX = event.clientX;
        startY = event.clientY;
        fromLeft = node.scrollLeft;
        fromTop = node.scrollTop;
    };

    const move = (event: PointerEvent) => {
        if (!active) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) < THRESHOLD) return;
        dragged = true;
        node.scrollLeft = fromLeft - dx;
        node.scrollTop = fromTop - dy;
        // ドラッグ中に文字が選択されると掴み心地が悪い
        event.preventDefault();
    };

    const up = () => {
        active = false;
    };

    // 掴んで動かした後のクリックで番組を開かない
    const click = (event: MouseEvent) => {
        if (!dragged) return;
        event.preventDefault();
        event.stopPropagation();
        dragged = false;
    };

    node.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    node.addEventListener('click', click, true);

    return {
        destroy() {
            node.removeEventListener('pointerdown', down);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            node.removeEventListener('click', click, true);
        },
    };
}
