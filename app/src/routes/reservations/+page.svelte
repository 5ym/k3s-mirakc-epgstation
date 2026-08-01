<script lang="ts">
    import { submitting } from '$lib/actions';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { badgeClass, CM_LABEL, dateTime, duration, size, stateLabel } from '$lib/format';

    let { data, form } = $props();

    // 録画・予約・配信のいずれかが動いたらサーバが知らせてくる
    liveUpdates(['recordings', 'reservations']);

    const active = ['scheduled', 'conflict', 'recording'];
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
    <h1 class="text-2xl font-bold">ダッシュボード</h1>
    <div class="flex flex-wrap gap-2">
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
                    <a class="link text-base font-normal" href="/">見る</a>
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
</div>

<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-lg font-bold">予約</h2>
    <div class="flex gap-2">
        <a class="btn btn-sm" href={data.showFinished ? '/' : '/?all=1'}>
            {data.showFinished ? '進行中のみ' : '完了分も表示'}
        </a>
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
                    <td class="text-sm">
                        <div class="whitespace-nowrap">
                            {res.manual ? '手動' : (res.rule_name ?? 'ルール')}
                        </div>
                        <!-- 番組ごとに変えられるので、何で録るのかは一覧から分かるようにする -->
                        <div class="mt-0.5 flex flex-wrap gap-1">
                            {#if res.encode}
                                <span class="badge badge-ghost badge-sm" data-testid="reservation-codec">
                                    {res.codec.toUpperCase()}
                                </span>
                                <span class="badge badge-ghost badge-sm" data-testid="reservation-cmcut">
                                    CM: {CM_LABEL[res.cm_cut] ?? res.cm_cut}
                                </span>
                            {:else}
                                <span class="badge badge-ghost badge-sm">TSのみ</span>
                            {/if}
                            {#if res.keep_original}
                                <span class="badge badge-ghost badge-sm">生TSも残す</span>
                            {/if}
                        </div>
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
