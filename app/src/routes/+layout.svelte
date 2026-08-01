<script lang="ts">
    import '../app.css';
    import { onMount } from 'svelte';
    import { page } from '$app/state';

    let { children } = $props();

    // ハイドレーション完了の目印。SSR直後のDOMに入力しても、ハイドレーションで
    // 値が書き戻されて消える。E2Eはこの印が付くのを待ってから操作する
    let hydrated = $state(false);
    // 実際の適用は app.html のインラインスクリプトが済ませてある。ここは表示合わせ
    let theme = $state('dark');
    onMount(() => {
        hydrated = true;
        theme = document.documentElement.dataset.theme ?? 'dark';
    });

    function toggleTheme() {
        theme = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('theme', theme);
    }

    const links = [
        { href: '/', label: 'ダッシュボード' },
        { href: '/guide', label: '番組表' },
        { href: '/reservations', label: '予約' },
        { href: '/rules', label: 'ルール' },
        { href: '/recordings', label: 'ライブラリ' },
        { href: '/settings', label: '設定' },
    ];
</script>

<div class="min-h-screen bg-base-200" data-hydrated={hydrated ? 'true' : undefined}>
    <div class="navbar bg-base-100 shadow-sm">
        <div class="flex-1">
            <a class="btn btn-ghost text-xl" href="/">denpa</a>
        </div>
        <nav class="flex-none items-center gap-1">
            <button
                class="btn btn-ghost btn-sm"
                onclick={toggleTheme}
                aria-label="テーマを切り替える"
                data-testid="theme-toggle"
            >
                {theme === 'dark' ? '🌙' : '☀️'}
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
    </div>

    <main class="p-4 md:p-6">
        {@render children()}
    </main>
</div>
