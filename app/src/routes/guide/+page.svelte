<script lang="ts">
    import { submitting } from '$lib/actions';
    import { dateTime, duration, stateLabel, time } from '$lib/format';

    let { data, form } = $props();

    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS' };
    const HOUR = 60 * 60 * 1000;
    /** 5分を1マスにする。細かすぎると行数が増えるだけ、粗いと短い番組が潰れる */
    const SLOT = 5 * 60 * 1000;

    const slots = $derived((data.hours * HOUR) / SLOT);
    const end = $derived(data.start + data.hours * HOUR);

    /** 何行目から何行分か。ヘッダーが1行目なので +2 */
    function place(program: { start_at: number; end_at: number }) {
        const from = Math.max(0, Math.floor((program.start_at - data.start) / SLOT));
        const to = Math.min(slots, Math.ceil((Math.min(program.end_at, end) - data.start) / SLOT));
        return { row: from + 2, span: Math.max(1, to - from) };
    }

    const columnOf = $derived(new Map(data.services.map((s, i) => [s.id, i + 2])));

    const hourMarks = $derived(
        Array.from({ length: data.hours }, (_, i) => ({
            at: data.start + i * HOUR,
            row: (i * HOUR) / SLOT + 2,
            span: HOUR / SLOT,
        })),
    );

    function href(params: Record<string, string>): string {
        const query = new URLSearchParams({ type: data.type, ...params });
        return `/guide?${query}`;
    }
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
    <h1 class="text-2xl font-bold">番組表</h1>
    <form method="GET" class="flex flex-wrap items-end gap-2" data-testid="guide-filter">
        <input type="hidden" name="type" value={data.type} />
        <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">キーワード</span>
            <input
                type="search"
                name="q"
                value={data.keyword}
                placeholder="全チャンネルから探す"
                class="input input-bordered"
                data-testid="filter-keyword"
            />
        </label>
        <button class="btn btn-primary" type="submit">検索</button>
        {#if data.keyword}
            <a class="btn" href={href({})} data-testid="clear-keyword">番組表に戻る</a>
        {/if}
    </form>
</div>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="guide-error">{form.message}</div>
{/if}

{#if data.mode === 'grid'}
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="join" data-testid="type-tabs">
            {#each ['GR', 'BS', 'CS'] as type (type)}
                <a
                    class="btn join-item btn-sm {data.type === type ? 'btn-active' : ''}"
                    href="/guide?type={type}&start={data.start}"
                    data-testid="type-{type}"
                >
                    {TYPE_LABEL[type]}
                </a>
            {/each}
        </div>
        <div class="flex items-center gap-2">
            <a class="btn btn-sm" href={href({ start: String(data.start - data.hours * HOUR) })}>← 前</a>
            <span class="text-sm" data-testid="window-label">
                {dateTime(data.start)} 〜 {time(end)}
            </span>
            <a class="btn btn-sm" href={href({ start: String(data.start + data.hours * HOUR) })}>次 →</a>
            <a class="btn btn-sm" href={href({})}>いま</a>
        </div>
    </div>

    {#if data.services.length === 0}
        <div class="rounded-box bg-base-100 p-6 text-center shadow" data-testid="empty-grid">
            <p class="text-base-content/60">
                {TYPE_LABEL[
                    data.type
                ]}のチャンネルがありません。ダッシュボードで「EPGを今すぐ取得」を実行してください。
            </p>
        </div>
    {:else}
        <div class="rounded-box bg-base-100 max-h-[75vh] overflow-auto shadow" data-testid="guide-grid">
            <div
                class="grid"
                style="grid-template-columns: 3.5rem repeat({data.services
                    .length}, minmax(11rem, 1fr)); grid-template-rows: auto repeat({slots}, 0.75rem);"
            >
                <!-- 左上の角。時刻列とチャンネル行の交点で、どちらにも追従させる -->
                <div class="bg-base-100 sticky top-0 left-0 z-30" style="grid-column: 1; grid-row: 1;"></div>
                {#each data.services as service, i (service.id)}
                    <div
                        class="bg-base-100 border-base-300 sticky top-0 z-20 truncate border-b px-2 py-2 text-sm font-medium"
                        style="grid-column: {i + 2}; grid-row: 1;"
                        title={service.name}
                    >
                        {service.name}
                    </div>
                {/each}

                {#each hourMarks as mark (mark.at)}
                    <div
                        class="bg-base-100 border-base-300 sticky left-0 z-10 border-t px-1 text-xs"
                        style="grid-column: 1; grid-row: {mark.row} / span {mark.span};"
                    >
                        {time(mark.at)}
                    </div>
                {/each}

                {#each data.programs as program (program.id)}
                    {@const pos = place(program)}
                    <div
                        class="overflow-hidden p-0.5"
                        style="grid-column: {columnOf.get(
                            program.service_id,
                        )}; grid-row: {pos.row} / span {pos.span};"
                        data-testid="grid-program"
                        data-program-id={program.id}
                    >
                        {#if program.reservation_state}
                            <div
                                class="bg-primary/20 border-primary h-full overflow-hidden rounded border-l-2 px-1 py-0.5 text-left"
                                title={program.description}
                            >
                                <div class="text-xs leading-tight font-medium">
                                    {time(program.start_at)}
                                    {program.name}
                                </div>
                                <div class="text-primary text-xs">
                                    {stateLabel(program.reservation_state)}
                                </div>
                            </div>
                        {:else}
                            <form method="POST" action="?/reserve" use:submitting class="h-full">
                                <input type="hidden" name="programId" value={program.id} />
                                <button
                                    class="bg-base-200 hover:bg-base-300 h-full w-full overflow-hidden rounded px-1 py-0.5 text-left"
                                    title="{program.name}&#10;{program.description}&#10;&#10;クリックで予約"
                                    data-testid="reserve-button"
                                >
                                    <span class="block text-xs leading-tight font-medium">
                                        {time(program.start_at)}
                                        {program.name}
                                    </span>
                                    <span class="text-base-content/60 block text-xs leading-tight">
                                        {program.description}
                                    </span>
                                </button>
                            </form>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>
    {/if}
{:else}
    <div class="rounded-box bg-base-100 overflow-x-auto shadow">
        <table class="table-zebra table">
            <thead>
                <tr>
                    <th>放送日時</th>
                    <th>チャンネル</th>
                    <th>番組</th>
                    <th class="w-32"></th>
                </tr>
            </thead>
            <tbody data-testid="program-list">
                {#each data.programs as program (program.id)}
                    <tr data-testid="program-row" data-program-id={program.id}>
                        <td class="whitespace-nowrap">
                            {dateTime(program.start_at)}
                            <span class="text-base-content/60 text-xs">
                                ({duration(program.start_at, program.end_at)})
                            </span>
                        </td>
                        <td class="whitespace-nowrap">{program.service_name}</td>
                        <td>
                            <div class="font-medium">{program.name}</div>
                            <div class="text-base-content/60 line-clamp-1 text-sm">{program.description}</div>
                        </td>
                        <td>
                            {#if program.reservation_state}
                                <span class="badge badge-info">
                                    {stateLabel(program.reservation_state)}
                                </span>
                            {:else}
                                <form method="POST" action="?/reserve" use:submitting>
                                    <input type="hidden" name="programId" value={program.id} />
                                    <button class="btn btn-sm btn-primary" data-testid="reserve-button">
                                        予約
                                    </button>
                                </form>
                            {/if}
                        </td>
                    </tr>
                {:else}
                    <tr><td colspan="4" class="text-base-content/60">番組がありません</td></tr>
                {/each}
            </tbody>
        </table>
    </div>
{/if}
