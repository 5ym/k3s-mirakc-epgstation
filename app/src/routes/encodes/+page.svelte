<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    import { onMount } from 'svelte';
    import { dateTime, percent, stateLabel, badgeClass } from '$lib/format';

    let { data, form } = $props();

    // 実行中のジョブがある間だけ定期的に読み直す。SSE を足すほどの更新頻度ではない
    onMount(() => {
        const timer = setInterval(() => {
            if (data.jobs.some((job) => job.state === 'running')) void invalidateAll();
        }, 5000);
        return () => clearInterval(timer);
    });
</script>

<h1 class="mb-4 text-2xl font-bold">エンコード</h1>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="encode-error">{form.message}</div>
{/if}

<div class="overflow-x-auto rounded-box bg-base-100 shadow">
    <table class="table table-zebra">
        <thead>
            <tr>
                <th>番組</th>
                <th class="w-64">進捗</th>
                <th>状態</th>
                <th>投入</th>
                <th class="w-32"></th>
            </tr>
        </thead>
        <tbody data-testid="encode-list">
            {#each data.jobs as job (job.id)}
                <tr data-testid="encode-row" data-job-id={job.id}>
                    <td>
                        <div class="font-medium">{job.recording_name}</div>
                        {#if job.error}
                            <div class="text-error line-clamp-2 font-mono text-xs">{job.error}</div>
                        {/if}
                    </td>
                    <td>
                        <progress class="progress progress-primary w-full" value={job.percent} max="1"
                        ></progress>
                        <div class="text-base-content/60 text-xs">
                            {percent(job.percent)}
                            {#if job.log}・{job.log}{/if}
                        </div>
                    </td>
                    <td>
                        <span class="badge {badgeClass(job.state)}" data-testid="encode-state">
                            {stateLabel(job.state)}
                        </span>
                    </td>
                    <td class="whitespace-nowrap text-sm">{dateTime(job.created_at)}</td>
                    <td>
                        {#if job.state === 'queued' || job.state === 'running'}
                            <form method="POST" action="?/cancel" use:enhance>
                                <input type="hidden" name="id" value={job.id} />
                                <button class="btn btn-sm btn-error btn-outline" data-testid="encode-cancel">
                                    中止
                                </button>
                            </form>
                        {:else if job.state === 'failed' || job.state === 'canceled'}
                            <form method="POST" action="?/retry" use:enhance>
                                <input type="hidden" name="id" value={job.id} />
                                <button class="btn btn-sm" data-testid="encode-retry">やり直す</button>
                            </form>
                        {/if}
                    </td>
                </tr>
            {:else}
                <tr><td colspan="5" class="text-base-content/60">ジョブはありません</td></tr>
            {/each}
        </tbody>
    </table>
</div>
