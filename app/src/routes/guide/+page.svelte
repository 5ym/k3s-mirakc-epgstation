<script lang="ts">
    import { page } from '$app/state';
    import { dragScroll, submitting } from '$lib/actions';
    import { dateTime, duration, stateLabel, time } from '$lib/format';

    let { data, form } = $props();

    // 検索条件はURLに持たせる。そのままルールにできるようにするため
    const exclude = $derived(page.url.searchParams.get('exclude') ?? '');
    const types = $derived((page.url.searchParams.get('types') ?? '').split(',').filter(Boolean));
    const free = $derived(page.url.searchParams.get('free') === '1');

    /** クリックした番組。詳細を出してから予約するかどうか決める */
    let selected = $state<(typeof data.programs)[number] | null>(null);

    /** 詳細情報。Mirakurun が拾った「出演者」などの見出し付きテキスト */
    function extended(json: string | null): [string, string][] {
        if (json === null || json === '') return [];
        try {
            return Object.entries(JSON.parse(json) as Record<string, string>);
        } catch {
            return [];
        }
    }

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

    const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
    function dayLabel(at: number): string {
        const d = new Date(at);
        return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
    }

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
        {#if data.mode === 'list'}
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
            <a class="btn btn-sm" href={href({ start: String(data.start - data.hours * HOUR) })}>← 前日</a>
            <span class="text-sm" data-testid="window-label">
                <!-- 日本の番組表の慣習で、1日は4時から翌4時まで -->
                {dayLabel(data.start)} <span class="text-base-content/60">(4:00〜翌4:00)</span>
            </span>
            <a class="btn btn-sm" href={href({ start: String(data.start + data.hours * HOUR) })}>翌日 →</a>
            <a class="btn btn-sm" href={href({})}>今日</a>
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
        <div
            class="rounded-box bg-base-100 max-h-[75vh] cursor-grab overflow-auto shadow active:cursor-grabbing"
            use:dragScroll
            data-testid="guide-grid"
        >
            <div
                class="grid"
                style="grid-template-columns: 3.5rem repeat({data.services
                    .length}, minmax(11rem, 1fr)); grid-template-rows: auto repeat({slots}, 0.75rem);"
            >
                <!-- 左上の角。時刻列とチャンネル行の交点で、どちらにも追従させる -->
                <div class="bg-base-100 sticky top-0 left-0 z-30" style="grid-column: 1; grid-row: 1;"></div>
                {#each data.services as service, i (service.id)}
                    <div
                        class="bg-base-100 border-base-300 sticky top-0 z-20 flex items-center gap-1.5 truncate border-b px-2 py-2 text-sm font-medium"
                        style="grid-column: {i + 2}; grid-row: 1;"
                        title={service.name}
                    >
                        {#if service.has_logo}
                            <!-- ロゴを持たない局もあるので、有るものだけ出す -->
                            <img
                                src="/api/services/{service.id}/logo"
                                alt=""
                                class="h-5 w-8 shrink-0 object-contain"
                                loading="lazy"
                            />
                        {/if}
                        <span class="truncate">{service.name}</span>
                    </div>
                {/each}

                {#each hourMarks as mark (mark.at)}
                    <div
                        class="bg-base-100 border-base-300 sticky left-0 z-10 border-t px-1 text-xs"
                        style="grid-column: 1; grid-row: {mark.row} / span {mark.span};"
                    >
                        {new Date(mark.at).getHours()}
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
                        <button
                            class="h-full w-full overflow-hidden rounded px-1 py-0.5 text-left {program.reservation_state
                                ? 'bg-primary/20 border-primary border-l-2'
                                : 'bg-base-200 hover:bg-base-300'}"
                            onclick={() => (selected = program)}
                            data-testid="program-button"
                        >
                            <span class="block text-xs leading-tight font-medium">
                                {time(program.start_at)}
                                {program.name}
                            </span>
                            {#if program.reservation_state}
                                <span class="text-primary block text-xs">
                                    {stateLabel(program.reservation_state)}
                                </span>
                            {:else}
                                <span class="text-base-content/60 block text-xs leading-tight">
                                    {program.description}
                                </span>
                            {/if}
                        </button>
                    </div>
                {/each}
            </div>
        </div>
    {/if}
{:else}
    <div class="card bg-base-100 mb-4 shadow">
        <div class="card-body gap-3 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-bold" data-testid="search-total">
                    条件に合う番組は {data.total} 件
                </span>
                <form method="POST" action="?/createRule" use:submitting data-testid="to-rule">
                    <input type="hidden" name="q" value={data.keyword} />
                    <input type="hidden" name="exclude" value={exclude} />
                    <input type="hidden" name="types" value={types.join(',')} />
                    <input type="hidden" name="free" value={free ? '1' : '0'} />
                    <button class="btn btn-sm btn-primary" data-testid="create-rule">
                        この条件でルールを作る
                    </button>
                </form>
            </div>

            <!-- ルールと同じ条件で絞り込む。ここで見えているものが、そのまま録れるものになる -->
            <form method="GET" class="flex flex-wrap items-end gap-3" data-testid="search-conditions">
                <input type="hidden" name="q" value={data.keyword} />
                <label class="flex flex-col gap-1">
                    <span class="text-sm font-medium">除外キーワード</span>
                    <input
                        name="exclude"
                        value={exclude}
                        class="input input-bordered input-sm"
                        data-testid="filter-exclude"
                    />
                </label>
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-medium">種別</span>
                    <div class="flex gap-3" data-testid="filter-types">
                        {#each ['GR', 'BS', 'CS'] as t (t)}
                            <label class="flex cursor-pointer items-center gap-1">
                                <input
                                    type="checkbox"
                                    name="types"
                                    value={t}
                                    checked={types.includes(t)}
                                    class="checkbox checkbox-sm"
                                />
                                <span class="text-sm">{TYPE_LABEL[t]}</span>
                            </label>
                        {/each}
                    </div>
                </div>
                <label class="flex cursor-pointer items-center gap-2">
                    <input
                        type="checkbox"
                        name="free"
                        value="1"
                        checked={free}
                        class="checkbox checkbox-sm"
                    />
                    <span class="text-sm">無料放送のみ</span>
                </label>
                <button class="btn btn-sm">絞り込む</button>
            </form>
        </div>
    </div>

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
                        <td class="whitespace-nowrap">
                            <span class="flex items-center gap-1.5">
                                <img
                                    src="/api/services/{program.service_id}/logo"
                                    alt=""
                                    class="h-5 w-8 shrink-0 object-contain"
                                    loading="lazy"
                                />
                                {program.service_name}
                            </span>
                        </td>
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

{#if selected}
    <div class="modal modal-open" role="dialog" data-testid="program-detail">
        <div class="modal-box max-w-2xl">
            <h3 class="text-lg font-bold">{selected.name}</h3>
            <p class="text-base-content/60 mt-1 text-sm">
                {dateTime(selected.start_at)} 〜 {time(selected.end_at)}
                ({duration(selected.start_at, selected.end_at)})
            </p>

            {#if selected.description}
                <p class="mt-3 text-sm whitespace-pre-wrap">{selected.description}</p>
            {/if}

            {#each extended(selected.extended) as [heading, body] (heading)}
                <div class="mt-3">
                    <div class="text-sm font-medium">{heading}</div>
                    <div class="text-base-content/70 text-sm whitespace-pre-wrap">{body}</div>
                </div>
            {/each}

            <div class="modal-action">
                {#if selected.reservation_state}
                    <span class="badge badge-info" data-testid="detail-state">
                        {stateLabel(selected.reservation_state)}
                    </span>
                {:else}
                    <form method="POST" action="?/reserve" use:submitting>
                        <input type="hidden" name="programId" value={selected.id} />
                        <button class="btn btn-primary" data-testid="detail-reserve">予約する</button>
                    </form>
                {/if}
                <button class="btn" onclick={() => (selected = null)} data-testid="detail-close">
                    閉じる
                </button>
            </div>
        </div>
        <button class="modal-backdrop" onclick={() => (selected = null)} aria-label="閉じる"></button>
    </div>
{/if}
