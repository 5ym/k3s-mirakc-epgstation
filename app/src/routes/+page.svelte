<script lang="ts">
    import { enhance } from '$app/forms';
    import { dateTime, duration, percent, stateLabel, badgeClass } from '$lib/format';

    let { data, form } = $props();
</script>

<div class="mb-4 flex items-center justify-between">
    <h1 class="text-2xl font-bold">ダッシュボード</h1>
    <div class="flex gap-2">
        {#if !data.jellyfin}
            <a class="btn btn-sm btn-warning" href="/settings" data-testid="jellyfin-unset">Jellyfin 未設定</a
            >
        {/if}
        <form method="POST" action="?/sync" use:enhance>
            <button class="btn btn-sm" data-testid="sync-button">EPGを今すぐ取得</button>
        </form>
    </div>
</div>

{#if form?.sync}
    <div class="alert alert-info mb-4" data-testid="sync-result">
        局 {form.sync.services} / 番組 {form.sync.programs} / 新規予約 {form.sync.reserved}
    </div>
{/if}

<div class="mb-6 flex flex-wrap gap-2" data-testid="status">
    <div class="badge badge-lg {data.mirakurun.ok ? 'badge-success' : 'badge-error'}">
        Mirakurun {data.mirakurun.ok ? (data.mirakurun.version ?? 'OK') : 'NG'}
    </div>
</div>

<div class="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="stats">
    <div class="card bg-base-100 shadow">
        <div class="card-body p-4">
            <div class="text-base-content/60 text-sm">視聴可能</div>
            <div class="text-3xl font-bold" data-testid="stat-available">{data.stats.available}</div>
        </div>
    </div>
    <div class="card bg-base-100 shadow">
        <div class="card-body p-4">
            <div class="text-base-content/60 text-sm">削除済み</div>
            <div class="text-3xl font-bold" data-testid="stat-deleted">{data.stats.deleted}</div>
        </div>
    </div>
    <div class="card bg-base-100 shadow">
        <div class="card-body p-4">
            <div class="text-base-content/60 text-sm">番組 / 局</div>
            <div class="text-3xl font-bold">{data.stats.programs} / {data.stats.services}</div>
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

<div class="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <section class="card bg-base-100 shadow" data-testid="now-recording">
        <div class="card-body">
            <h2 class="card-title">録画中</h2>
            {#if data.recording.length === 0}
                <p class="text-base-content/60">なし</p>
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

    <section class="card bg-base-100 shadow" data-testid="upcoming">
        <div class="card-body">
            <h2 class="card-title">これからの予約</h2>
            {#if data.upcoming.length === 0}
                <p class="text-base-content/60">なし</p>
            {:else}
                <ul class="space-y-2">
                    {#each data.upcoming as res (res.id)}
                        <li class="flex items-start justify-between gap-2">
                            <div>
                                <div class="font-medium">{res.name}</div>
                                <div class="text-base-content/60 text-sm">{dateTime(res.start_at)}</div>
                            </div>
                            <span class="badge {badgeClass(res.state)}">{stateLabel(res.state)}</span>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </section>

    <section class="card bg-base-100 shadow" data-testid="live-sessions">
        <div class="card-body">
            <h2 class="card-title">Jellyfin へ配信中</h2>
            {#if data.live.length === 0}
                <p class="text-base-content/60">なし</p>
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
                            <form method="POST" action="?/stopLive" use:enhance>
                                <input type="hidden" name="id" value={session.id} />
                                <button class="btn btn-xs" data-testid="live-stop">切断</button>
                            </form>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </section>

    <section class="card bg-base-100 shadow" data-testid="encode-queue">
        <div class="card-body">
            <h2 class="card-title">エンコード</h2>
            {#if data.encoding.length === 0}
                <p class="text-base-content/60">なし</p>
            {:else}
                <ul class="space-y-3">
                    {#each data.encoding as job (job.id)}
                        <li>
                            <div class="flex justify-between gap-2">
                                <span class="truncate font-medium">{job.recording_name}</span>
                                <span class="badge {badgeClass(job.state)}">{stateLabel(job.state)}</span>
                            </div>
                            <progress class="progress progress-primary w-full" value={job.percent} max="1"
                            ></progress>
                            <div class="text-base-content/60 text-xs">{percent(job.percent)}</div>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </section>
</div>
