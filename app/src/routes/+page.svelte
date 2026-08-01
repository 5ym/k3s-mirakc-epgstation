<script lang="ts">
    import { invalidateAll } from '$app/navigation';
    import { submitting } from '$lib/actions';
    import { badgeClass, dateTime, duration, size, stateLabel } from '$lib/format';

    let { data, form } = $props();

    // 録画中や配信中はその場で状態が変わるので、その間だけ読み直す
    const polling = $derived(data.recording.length > 0 || data.live.length > 0);
    $effect(() => {
        if (!polling) return;
        const timer = setInterval(() => void invalidateAll(), 5000);
        return () => clearInterval(timer);
    });

    const active = ['scheduled', 'conflict', 'recording'];
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
    <h1 class="text-2xl font-bold">ダッシュボード</h1>
    <div class="flex flex-wrap gap-2">
        {#if !data.jellyfin}
            <a class="btn btn-sm btn-warning" href="/settings" data-testid="jellyfin-unset">Jellyfin 未設定</a
            >
        {/if}
        <div class="flex items-center gap-2" data-testid="status">
            <div class="badge badge-lg {data.mirakurun.ok ? 'badge-success' : 'badge-error'}">
                Mirakurun {data.mirakurun.ok ? (data.mirakurun.version ?? 'OK') : 'NG'}
            </div>
            <div class="badge badge-lg badge-ghost" title="取り込み済みの番組数と局数">
                番組 {data.stats.programs} / 局 {data.stats.services}
            </div>
        </div>
        <form method="POST" action="?/sync" use:submitting>
            <button class="btn btn-sm" data-testid="sync-button">EPGを今すぐ取得</button>
        </form>
    </div>
</div>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="dashboard-error">{form.message}</div>
{/if}
{#if form?.sync}
    <div class="alert alert-info mb-4" data-testid="sync-result">
        局 {form.sync.services} / 番組 {form.sync.programs} / 新規予約 {form.sync.reserved}
    </div>
{/if}
{#if form?.timers}
    <div class="alert alert-info mb-4" data-testid="import-result">
        取り込み {form.timers.imported} 件 / 対象外 {form.timers.skipped} 件 / 失敗 {form.timers.failed} 件
        {#each form.timers.messages as message}<span class="ml-2 text-sm">{message}</span>{/each}
    </div>
{/if}

{#if data.failures.length > 0}
    <div class="alert alert-error mb-4 items-start" data-testid="failures">
        <div class="w-full">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-bold">失敗した録画が {data.failures.length} 件あります</span>
                <form method="POST" action="?/acknowledge" use:submitting>
                    <button class="btn btn-xs" data-testid="ack-all">すべて確認済みにする</button>
                </form>
            </div>
            <ul class="mt-1 space-y-1 text-sm">
                {#each data.failures as failure (failure.id)}
                    <li class="flex items-start justify-between gap-2" data-testid="failure-row">
                        <span>
                            {dateTime(failure.updated_at)}
                            {failure.name} — {failure.error ?? '理由不明'}
                        </span>
                        <form method="POST" action="?/acknowledge" use:submitting>
                            <input type="hidden" name="id" value={failure.id} />
                            <button class="btn btn-xs" data-testid="ack-one">確認</button>
                        </form>
                    </li>
                {/each}
            </ul>
        </div>
    </div>
{/if}

<div class="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="stats">
    <div class="card bg-base-100 shadow">
        <div class="card-body p-4">
            <div class="text-base-content/60 text-sm">24時間以内の予約</div>
            <div class="text-3xl font-bold" data-testid="stat-today">{data.stats.today}</div>
        </div>
    </div>
    <div class="card bg-base-100 shadow">
        <div class="card-body p-4">
            <div class="text-base-content/60 text-sm">視聴可能 / 使用容量</div>
            <div class="text-3xl font-bold" data-testid="stat-available">
                {data.stats.available}
                <span class="text-base-content/60 text-base font-normal">{size(data.stats.bytes)}</span>
            </div>
        </div>
    </div>
    <div class="card bg-base-100 shadow">
        <div class="card-body p-4">
            <div class="text-base-content/60 text-sm">エンコード待ち</div>
            <div class="text-3xl font-bold">
                {data.stats.encoding}
                {#if data.stats.encoding > 0}
                    <a class="link text-base font-normal" href="/recordings">見る</a>
                {/if}
            </div>
        </div>
    </div>
    <div class="card bg-base-100 shadow">
        <div class="card-body p-4">
            <div class="text-base-content/60 text-sm">競合中の予約</div>
            <div class="text-3xl font-bold {data.stats.conflicts > 0 ? 'text-error' : ''}">
                {data.stats.conflicts}
            </div>
        </div>
    </div>
</div>

<div class="mb-4 grid gap-4 lg:grid-cols-2">
    <section class="card bg-base-100 shadow" data-testid="now-recording">
        <div class="card-body p-4">
            <h2 class="card-title text-base">録画中</h2>
            {#if data.recording.length === 0}
                <p class="text-base-content/60 text-sm">なし</p>
            {:else}
                <ul class="space-y-2">
                    {#each data.recording as rec (rec.id)}
                        <li>
                            <div class="font-medium">{rec.name}</div>
                            <div class="text-base-content/60 text-sm">
                                {rec.service_name} / {dateTime(rec.start_at)} ({duration(
                                    rec.start_at,
                                    rec.end_at,
                                )})
                            </div>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </section>

    <section class="card bg-base-100 shadow" data-testid="live-sessions">
        <div class="card-body p-4">
            <h2 class="card-title text-base">Jellyfin へ配信中</h2>
            {#if data.live.length === 0}
                <p class="text-base-content/60 text-sm">なし</p>
            {:else}
                <p class="text-base-content/60 text-xs">
                    チューナーは録画と共有です。録画が始まると優先度の低い配信は切られます。
                </p>
                <ul class="space-y-2">
                    {#each data.live as session (session.id)}
                        <li
                            class="flex items-center justify-between gap-2"
                            data-testid="live-session"
                            data-session-id={session.id}
                        >
                            <span>
                                {session.serviceName}
                                <span class="badge badge-sm badge-ghost">{session.profile}</span>
                                <span class="text-base-content/60 text-xs">
                                    {dateTime(session.startedAt)} から
                                </span>
                            </span>
                            <form method="POST" action="?/stopLive" use:submitting>
                                <input type="hidden" name="id" value={session.id} />
                                <button class="btn btn-xs" data-testid="live-stop">切断</button>
                            </form>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </section>
</div>

<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-lg font-bold">予約</h2>
    <div class="flex gap-2">
        <a class="btn btn-sm" href={data.showFinished ? '/' : '/?all=1'}>
            {data.showFinished ? '進行中のみ' : '完了分も表示'}
        </a>
        {#if data.jellyfin}
            <form method="POST" action="?/importTimers" use:submitting>
                <button class="btn btn-sm" data-testid="import-timers">Jellyfinの録画予約を取り込む</button>
            </form>
        {/if}
        <form method="POST" action="?/resolve" use:submitting>
            <button class="btn btn-sm">競合を再計算</button>
        </form>
    </div>
</div>

<div class="overflow-x-auto rounded-box bg-base-100 shadow">
    <table class="table table-zebra">
        <thead>
            <tr>
                <th>放送日時</th>
                <th>チャンネル</th>
                <th>番組</th>
                <th>種別</th>
                <th>状態</th>
                <th class="w-28"></th>
            </tr>
        </thead>
        <tbody data-testid="reservation-list">
            {#each data.reservations as res (res.id)}
                <tr
                    data-testid="reservation-row"
                    data-reservation-id={res.id}
                    data-program-id={res.program_id}
                >
                    <td class="whitespace-nowrap">
                        {dateTime(res.start_at)}
                        <span class="text-base-content/60 text-xs">
                            ({duration(res.start_at, res.end_at)})
                        </span>
                    </td>
                    <td class="whitespace-nowrap">{res.service_name}</td>
                    <td>
                        <div class="font-medium">{res.name}</div>
                        {#if res.conflict_reason}
                            <div class="text-error text-sm">{res.conflict_reason}</div>
                        {/if}
                    </td>
                    <td class="whitespace-nowrap text-sm">
                        {res.manual ? '手動' : (res.rule_name ?? 'ルール')}
                        {#if !res.encode}<span class="badge badge-ghost badge-sm">TSのみ</span>{/if}
                    </td>
                    <td>
                        <span class="badge {badgeClass(res.state)}" data-testid="reservation-state">
                            {stateLabel(res.state)}
                        </span>
                    </td>
                    <td>
                        {#if active.includes(res.state)}
                            <form method="POST" action="?/cancel" use:submitting>
                                <input type="hidden" name="id" value={res.id} />
                                <button class="btn btn-sm btn-error btn-outline" data-testid="cancel-button">
                                    取消
                                </button>
                            </form>
                        {/if}
                    </td>
                </tr>
            {:else}
                <tr><td colspan="6" class="text-base-content/60">予約はありません</td></tr>
            {/each}
        </tbody>
    </table>
</div>
