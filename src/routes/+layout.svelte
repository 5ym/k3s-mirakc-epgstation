<script lang="ts">
    import '../app.css';
    import { onMount } from 'svelte';
    import { navigating, page } from '$app/state';
    import { busy } from '$lib/busy.svelte';

    let { children } = $props();

    // ハイドレーション完了の目印。SSR直後のDOMに入力しても、ハイドレーションで
    // 値が書き戻されて消える。E2Eはこの印が付くのを待ってから操作する
    let hydrated = $state(false);

    /** system は端末の設定に従う。既定はこれ */
    let mode = $state<'system' | 'light' | 'dark'>('system');
    const LABEL = { system: '端末に合わせる', light: 'ライト', dark: 'ダーク' };
    const ICON = { system: '🖥️', light: '☀️', dark: '🌙' };

    function apply() {
        const dark =
            mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        document.documentElement.dataset.themeMode = mode;
    }

    onMount(() => {
        hydrated = true;
        mode = (document.documentElement.dataset.themeMode as 'system' | 'light' | 'dark') ?? 'system';

        // 端末側の設定が変わったら、system のときだけ追従する
        const media = matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            if (mode === 'system') apply();
        };
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    });

    function cycleTheme() {
        mode = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system';
        // system のときは保存しない。そうしないと端末側を変えても追従しなくなる
        if (mode === 'system') localStorage.removeItem('theme');
        else localStorage.setItem('theme', mode);
        apply();
    }

    const links = [
        { href: '/', label: '予約と録画' },
        { href: '/guide', label: '番組表' },
        { href: '/rules', label: 'ルール' },
        { href: '/tuners', label: 'チューナー' },
        { href: '/settings', label: '設定' },
    ];

    /** ページ名はナビと同じものを使う。タブに出す */
    const title = $derived(`${links.find((l) => l.href === page.url.pathname)?.label ?? 'denpa'} - denpa`);

    /**
     * 予約と録画だけは画面ぴったりの高さにして、中の一覧だけをスクロールさせる
     * (2つ並べたときに片方だけ下に置いていかれないため)。
     *
     * 他の画面まで同じにすると、スクロールするのが window ではなくなり、
     * 戻ったときに見ていた位置へ帰らなくなる。畳まれる幅ではどの画面も
     * 普通にページごとスクロールさせる
     */
    const fill = $derived(page.url.pathname === '/');
</script>

<svelte:head>
    <title>{title}</title>
</svelte:head>

<div
    class="flex min-h-screen flex-col bg-base-200 {fill ? 'lg:h-screen lg:min-h-0 lg:overflow-hidden' : ''}"
    data-hydrated={hydrated ? 'true' : undefined}
>
    <div class="navbar bg-base-100 sticky top-0 z-40 shadow-sm">
        <div class="flex-1">
            <a class="btn btn-ghost text-xl" href="/">denpa</a>
        </div>
        <nav class="flex-none items-center gap-1">
            <button
                class="btn btn-ghost btn-sm"
                onclick={cycleTheme}
                aria-label="テーマを切り替える"
                title={LABEL[mode]}
                data-testid="theme-toggle"
                data-mode={mode}
            >
                {ICON[mode]}
            </button>
            <ul class="menu menu-horizontal px-1">
                {#each links as link (link.href)}
                    <li>
                        <a
                            href={link.href}
                            class={page.url.pathname === link.href ? 'active' : ''}
                            data-testid="nav-{link.href === '/' ? 'home' : link.href.slice(1)}"
                        >
                            {link.label}
                        </a>
                    </li>
                {/each}
            </ul>
        </nav>

        <!--
            画面遷移とフォーム送信の待ち時間を出す。番組表やEPG取得は数秒かかることがあり、
            無反応に見えると二度押しされる。ヘッダーの下端に重ねて、隙間ができないようにする
        -->
        <div
            class="absolute inset-x-0 -bottom-1 h-1 leading-none"
            data-testid="loading-bar"
            data-loading={navigating.to || busy.active ? 'true' : undefined}
        >
            {#if navigating.to || busy.active}
                <progress class="progress progress-primary block h-1 w-full rounded-none"></progress>
            {/if}
        </div>
    </div>

    <main class="p-4 md:p-6 {fill ? 'lg:min-h-0 lg:flex-1' : ''}">
        {@render children()}
    </main>
</div>
