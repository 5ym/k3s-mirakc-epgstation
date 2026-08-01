<script lang="ts">
    import { submitting } from '$lib/actions';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { detectPlatform, type Platform, playLinks } from '$lib/play';
    import {
        badgeClass,
        CM_LABEL,
        cmRanges,
        dateTime,
        duration,
        percent,
        size,
        stateLabel,
    } from '$lib/format';

    let { data, form } = $props();

    // サーバから通知が来たら読み直す
    liveUpdates(['recordings']);

    /**
     * どのプレイヤーに渡すかは端末で決まるので、サーバでは決められない。
     * origin もブラウザでしか分からないので、判定できるまで再生リンクは出さない
     */
    let platform = $state<Platform | null>(null);
    let origin = $state('');
    $effect(() => {
        platform = detectPlatform(navigator.userAgent);
        origin = location.origin;
    });

    /** プレイヤーに渡すので絶対URLにする */
    const fileUrl = (id: number) => `${origin}/api/recordings/${id}/file`;
</script>

<div class="mb-4 flex items-center justify-between">
    <h1 class="text-2xl font-bold">録画</h1>
    <div class="flex gap-2">
        <a class="btn btn-sm" href={data.showDeleted ? '/' : '/?deleted=1'}>
            {data.showDeleted ? '現存分を表示' : '削除済みを表示'}
        </a>
        <form method="POST" action="?/reconcile" use:submitting>
            <button class="btn btn-sm" data-testid="reconcile-button">実体と照合</button>
        </form>
    </div>
</div>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="recording-error">{form.message}</div>
{/if}
{#if form?.reconcile}
    <div class="alert alert-info mb-4" data-testid="reconcile-result">
        照合 {form.reconcile.checked} 件 / Jellyfin側で削除済み {form.reconcile.removed} 件
    </div>
{/if}

{#if data.jobs.length > 0}
    <div class="card bg-base-100 mb-4 shadow" data-testid="encode-panel">
        <div class="card-body gap-3">
            <h2 class="card-title text-base">エンコード</h2>
            <ul class="space-y-3" data-testid="encode-list">
                {#each data.jobs as job (job.id)}
                    <li data-testid="encode-row" data-job-id={job.id}>
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <span class="font-medium">{job.recording_name}</span>
                            <div class="flex items-center gap-2">
                                <span class="badge {badgeClass(job.state)}" data-testid="encode-state">
                                    {stateLabel(job.state)}
                                </span>
                                {#if job.state === 'queued' || job.state === 'running'}
                                    <form method="POST" action="?/cancelEncode" use:submitting>
                                        <input type="hidden" name="id" value={job.id} />
                                        <button
                                            class="btn btn-xs btn-error btn-outline"
                                            data-testid="encode-cancel"
                                        >
                                            中止
                                        </button>
                                    </form>
                                {:else}
                                    <form method="POST" action="?/retryEncode" use:submitting>
                                        <input type="hidden" name="id" value={job.id} />
                                        <button class="btn btn-xs" data-testid="encode-retry">やり直す</button
                                        >
                                    </form>
                                    <form method="POST" action="?/dismissEncode" use:submitting>
                                        <input type="hidden" name="id" value={job.id} />
                                        <button class="btn btn-xs btn-ghost" data-testid="encode-dismiss">
                                            消す
                                        </button>
                                    </form>
                                {/if}
                            </div>
                        </div>
                        {#if job.state === 'running' || job.state === 'queued'}
                            <progress class="progress progress-primary w-full" value={job.percent} max="1"
                            ></progress>
                            <div class="text-base-content/60 text-xs">
                                {percent(job.percent)}{#if job.log}・{job.log}{/if}
                            </div>
                        {:else if job.error}
                            <div class="text-error line-clamp-2 font-mono text-xs">{job.error}</div>
                        {/if}
                    </li>
                {/each}
            </ul>
        </div>
    </div>
{/if}

<div class="overflow-x-auto rounded-box bg-base-100 shadow">
    <table class="table table-zebra">
        <thead>
            <tr>
                <th>放送日時</th>
                <th>番組</th>
                <th>サイズ</th>
                <th>状態</th>
                <th class="w-56"></th>
            </tr>
        </thead>
        <tbody data-testid="recording-list">
            {#each data.recordings as rec (rec.id)}
                <tr data-testid="recording-row" data-recording-id={rec.id} data-program-id={rec.program_id}>
                    <td class="whitespace-nowrap">
                        {dateTime(rec.start_at)}
                        <span class="text-base-content/60 text-xs">
                            ({duration(rec.start_at, rec.end_at)})
                        </span>
                    </td>
                    <td>
                        <div class="font-medium">{rec.name}</div>
                        <div class="text-base-content/60 text-sm">
                            {rec.service_name}
                            {#if rec.library_path}
                                <span class="ml-1 font-mono text-xs">{rec.library_path}</span>
                            {/if}
                        </div>
                        {#if rec.error}
                            <!-- 削除済みの行では error 列に削除理由が入る。失敗ではないので赤くしない -->
                            <div
                                class={rec.deleted_at === null
                                    ? 'text-error text-sm'
                                    : 'text-base-content/60 text-sm'}
                            >
                                {rec.error}
                            </div>
                        {/if}
                        <div class="text-base-content/60 text-xs" data-testid="cm-info">
                            {rec.codec.toUpperCase()}
                            {#if rec.cm_cut !== 'off'}
                                ・CM {CM_LABEL[rec.cm_cut]}
                                {#if cmRanges(rec.cm_ranges)}・{cmRanges(rec.cm_ranges)}{/if}
                            {/if}
                        </div>
                    </td>
                    <td class="whitespace-nowrap">{size(rec.ts_size)}</td>
                    <td class="whitespace-nowrap">
                        <span class="badge {badgeClass(rec.state)}" data-testid="recording-state">
                            {stateLabel(rec.state)}
                        </span>
                    </td>
                    <td class="flex flex-wrap gap-2">
                        {#if rec.deleted_at === null}
                            {#if rec.state === 'available' && platform !== null}
                                <!--
                                    ブラウザは MPEG-2 も AV1+Opus の mkv も素直には再生できない。
                                    端末に入っているプレイヤーに URL を渡して開かせる
                                -->
                                {#each playLinks(fileUrl(rec.id), rec.name, platform, data.credentials) as link (link.href)}
                                    <a
                                        class="btn btn-sm btn-primary"
                                        href={link.href}
                                        data-testid="play-link"
                                        title={link.note ?? ''}
                                    >
                                        {link.label}
                                    </a>
                                {/each}
                                <a
                                    class="btn btn-sm btn-ghost"
                                    href={`/api/recordings/${rec.id}/file`}
                                    download
                                    data-testid="download-link"
                                >
                                    保存
                                </a>
                            {/if}
                            <!-- 録画中・エンコード中は生TSがまだ書かれている最中なので触らせない -->
                            {#if rec.ts_path && rec.state !== 'recording' && rec.state !== 'encoding'}
                                <form method="POST" action="?/reencode" use:submitting>
                                    <input type="hidden" name="id" value={rec.id} />
                                    <button class="btn btn-sm" data-testid="reencode-button"
                                        >再エンコード</button
                                    >
                                </form>
                            {/if}
                            <form method="POST" action="?/delete" use:submitting>
                                <input type="hidden" name="id" value={rec.id} />
                                <button class="btn btn-sm btn-error btn-outline" data-testid="delete-button">
                                    削除
                                </button>
                            </form>
                        {/if}
                    </td>
                </tr>
            {:else}
                <tr><td colspan="5" class="text-base-content/60">録画はありません</td></tr>
            {/each}
        </tbody>
    </table>
</div>
