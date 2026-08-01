<script lang="ts">
    import { submitting } from '$lib/actions';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { detectPlatform, type Platform, playLinks } from '$lib/play';
    import {
        badgeClass,
        cmRanges,
        date,
        dateTime,
        duration,
        percent,
        size,
        stateLabel,
        time,
    } from '$lib/format';
    import type { ProgramDetail as Detail } from '$lib/types';

    let { data, form } = $props();

    // 予約・録画のどちらが動いてもサーバが知らせてくる
    liveUpdates(['recordings', 'reservations']);

    const active = ['scheduled', 'conflict', 'recording'];

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

    /** 行から開いた番組詳細。番組表と同じ見せ方をする */
    let detail = $state<Detail | null>(null);

    /** 続けて別の行を押したとき、遅れて届いた前の結果で上書きされないようにする */
    let opened = 0;

    /** 行が自分で持っている分。EPG から引けなくても、これだけは必ず出せる */
    interface Row {
        name: string;
        service_name: string;
        description: string;
        start_at: number;
        end_at: number;
    }

    /**
     * 行を押したら番組詳細を出す。
     *
     * まず行が持っている分をすぐ出し、EPG から引けたら中身を差し替える。
     * 古い録画は番組が EPG から消えているので、引けないことのほうが普通。
     */
    async function openDetail(programId: number | null, row: Row): Promise<void> {
        const token = ++opened;
        detail = {
            ...row,
            extended: null,
            genre_detail: null,
            audios: null,
            video_type: null,
            video_resolution: null,
            is_free: 1,
        };
        if (programId === null) return;

        const res = await fetch(`/api/programs/${programId}`);
        if (res.ok && token === opened) detail = await res.json();
    }

    /** 行のどこを押しても開く。ただしボタンやリンクを押したときは邪魔しない */
    function rowClick(event: MouseEvent | KeyboardEvent, programId: number | null, row: Row): void {
        if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
        if ((event.target as HTMLElement).closest('a, button, input, label')) return;
        void openDetail(programId, row);
    }
</script>

<h1 class="mb-4 text-2xl font-bold">予約と録画</h1>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="dashboard-error">{form.message}</div>
{/if}

<div class="grid gap-6 xl:grid-cols-5">
    <section class="xl:col-span-2">
        <div class="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
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
                        <th class="whitespace-nowrap">放送日時</th>
                        <!-- 番組名は長いので、余りは全部こちらに寄せる -->
                        <th class="w-full">番組</th>
                        <th class="whitespace-nowrap">種別</th>
                        <th class="whitespace-nowrap">状態</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody data-testid="reservation-list">
                    {#each data.reservations as res (res.id)}
                        <!-- 行を押すと番組表と同じ詳細が出る -->
                        <tr
                            data-testid="reservation-row"
                            data-reservation-id={res.id}
                            data-program-id={res.program_id}
                            class="hover cursor-pointer"
                            tabindex="0"
                            onclick={(event) => rowClick(event, res.program_id, res)}
                            onkeydown={(event) => rowClick(event, res.program_id, res)}
                        >
                            <!-- 日付と時刻で2行にする。1行だと番組名の幅をだいぶ食う -->
                            <td class="whitespace-nowrap">
                                <div>{date(res.start_at)}</div>
                                <div class="text-base-content/60 text-sm">
                                    {time(res.start_at)}〜{time(res.end_at)}
                                    ({duration(res.start_at, res.end_at)})
                                </div>
                            </td>
                            <!--
                                局名は番組名の下に小さく。録画一覧と同じ出し方。
                                max-w-0 は truncate を効かせるため(中身が幅を押し広げるのを止める)
                            -->
                            <td class="max-w-0">
                                <div class="truncate font-medium" title={res.name}>{res.name}</div>
                                <div class="text-base-content/60 truncate text-sm">{res.service_name}</div>
                                {#if res.conflict_reason}
                                    <div class="text-error text-sm">{res.conflict_reason}</div>
                                {/if}
                            </td>
                            <td class="text-sm">
                                <div class="whitespace-nowrap">
                                    {res.manual ? '手動' : (res.rule_name ?? 'ルール')}
                                </div>
                                <div class="mt-0.5 flex flex-wrap gap-1">
                                    {#if !res.encode}
                                        <span class="badge badge-ghost badge-sm">TSのみ</span>
                                    {/if}
                                    {#if res.keep_original}
                                        <span class="badge badge-ghost badge-sm">生TSも残す</span>
                                    {/if}
                                </div>
                            </td>
                            <!-- 番組の列に幅を寄せているぶん、こちらは縦書きにならないよう畳ませない -->
                            <td class="whitespace-nowrap">
                                <span
                                    class="badge whitespace-nowrap {badgeClass(res.state)}"
                                    data-testid="reservation-state"
                                >
                                    {stateLabel(res.state)}
                                </span>
                            </td>
                            <td class="whitespace-nowrap">
                                {#if active.includes(res.state)}
                                    <form method="POST" action="?/cancel" use:submitting>
                                        <input type="hidden" name="id" value={res.id} />
                                        <button
                                            class="btn btn-sm btn-error btn-outline"
                                            data-testid="cancel-button"
                                        >
                                            取消
                                        </button>
                                    </form>
                                {/if}
                            </td>
                        </tr>
                    {:else}
                        <tr><td colspan="5" class="text-base-content/60">予約はありません</td></tr>
                    {/each}
                </tbody>
            </table>
        </div>
    </section>

    <section class="xl:col-span-3">
        <!-- 見出しの高さと下の余白は予約側と揃える。並べたときにずれて見えるため -->
        <div class="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
            <h2 class="text-lg font-bold">録画</h2>
            <div class="flex gap-2">
                <a class="btn btn-sm" href={data.showDeleted ? '/' : '/?deleted=1'}>
                    {data.showDeleted ? '現存分を表示' : '削除済みを表示'}
                </a>
                <form method="POST" action="?/reconcile" use:submitting>
                    <button class="btn btn-sm" data-testid="reconcile-button">実体と照合</button>
                </form>
            </div>
        </div>

        <!-- エラーは画面の頭に1つだけ出す。予約も録画も同じ form を見るので、
             ここにも出すと同じ文言が2回並ぶ -->
        {#if form?.reconcile}
            <div class="alert alert-info mb-4" data-testid="reconcile-result">
                照合 {form.reconcile.checked} 件 / 実体が無く削除済み {form.reconcile.removed} 件
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
                                        <span
                                            class="badge {badgeClass(job.state)}"
                                            data-testid="encode-state"
                                        >
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
                                                <button class="btn btn-xs" data-testid="encode-retry"
                                                    >やり直す</button
                                                >
                                            </form>
                                            <form method="POST" action="?/dismissEncode" use:submitting>
                                                <input type="hidden" name="id" value={job.id} />
                                                <button
                                                    class="btn btn-xs btn-ghost"
                                                    data-testid="encode-dismiss"
                                                >
                                                    消す
                                                </button>
                                            </form>
                                        {/if}
                                    </div>
                                </div>
                                {#if job.state === 'running' || job.state === 'queued'}
                                    <progress
                                        class="progress progress-primary w-full"
                                        value={job.percent}
                                        max="1"
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
                        <th class="whitespace-nowrap">放送日時</th>
                        <!-- 番組名は長いので、余りは全部こちらに寄せる -->
                        <th class="w-full">番組</th>
                        <th class="whitespace-nowrap">サイズ</th>
                        <th class="whitespace-nowrap">状態</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody data-testid="recording-list">
                    {#each data.recordings as rec (rec.id)}
                        <!-- 行を押すと番組表と同じ詳細が出る -->
                        <tr
                            data-testid="recording-row"
                            data-recording-id={rec.id}
                            data-program-id={rec.program_id}
                            data-library-path={rec.library_path}
                            class="hover cursor-pointer"
                            tabindex="0"
                            onclick={(event) => rowClick(event, rec.program_id, rec)}
                            onkeydown={(event) => rowClick(event, rec.program_id, rec)}
                        >
                            <td class="whitespace-nowrap">
                                {dateTime(rec.start_at)}
                                <span class="text-base-content/60 text-xs">
                                    ({duration(rec.start_at, rec.end_at)})
                                </span>
                            </td>
                            <!-- max-w-0 は truncate を効かせるため -->
                            <td class="max-w-0">
                                <div class="truncate font-medium" title={rec.name}>{rec.name}</div>
                                <!-- ファイルの置き場所は普段は見ないので出さない。
                                     必要なときは data-library-path を見る -->
                                <div class="text-base-content/60 truncate text-sm">{rec.service_name}</div>
                                {#if rec.error}
                                    <!--
                                        失敗の理由はこの行にそのまま出す。上にまとめて出していた頃は
                                        どの録画のことか見に行く必要があった。
                                        削除済みの行では error 列に削除理由が入る。失敗ではないので赤くしない
                                    -->
                                    <div
                                        class="line-clamp-2 text-sm {rec.deleted_at === null
                                            ? 'text-error'
                                            : 'text-base-content/60'}"
                                        title={rec.error}
                                        data-testid="recording-error"
                                    >
                                        {rec.error}
                                    </div>
                                {/if}
                                {#if rec.cm_cut !== 'off' && cmRanges(rec.cm_ranges)}
                                    <!-- 何を検出したかは録画ごとに違うので出す。
                                         コーデックとCMの設定そのものは全体設定なので出さない -->
                                    <div class="text-base-content/60 text-xs" data-testid="cm-info">
                                        CM {cmRanges(rec.cm_ranges)}
                                    </div>
                                {/if}
                            </td>
                            <td class="whitespace-nowrap">{size(rec.ts_size)}</td>
                            <td class="whitespace-nowrap">
                                <span
                                    class="badge whitespace-nowrap {badgeClass(rec.state)}"
                                    data-testid="recording-state"
                                >
                                    {stateLabel(rec.state)}
                                </span>
                            </td>
                            <!-- 畳ませない。番組の列に幅を寄せているので、許すとボタンが縦積みになる -->
                            <td class="whitespace-nowrap">
                                <div class="flex flex-nowrap items-center gap-2">
                                    {#if rec.deleted_at === null}
                                        {#if rec.library_path !== null && platform !== null}
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
                                                ダウンロード
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
                                            <button
                                                class="btn btn-sm btn-error btn-outline"
                                                data-testid="delete-button"
                                            >
                                                削除
                                            </button>
                                        </form>
                                    {/if}
                                </div>
                            </td>
                        </tr>
                    {:else}
                        <tr><td colspan="5" class="text-base-content/60">録画はありません</td></tr>
                    {/each}
                </tbody>
            </table>
        </div>
    </section>
</div>

{#if detail}
    <ProgramDetail program={detail} onclose={() => (detail = null)} />
{/if}
