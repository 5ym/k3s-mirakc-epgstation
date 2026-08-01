<script lang="ts">
    import { dragScroll, submitting } from '$lib/actions';
    import { type Audio, audioLabel, type Genre, genreLabel, videoLabel } from '$lib/arib';
    import { CM_LABEL, dateTime, duration, stateLabel, time } from '$lib/format';

    let { data, form } = $props();

    // 検索条件はURLに持たせる。そのままルールにできるようにするため

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

    /** JSON で持っている列を読む。取り込みの時期によっては入っていないので空で返す */
    function parse<T>(json: string | null): T[] {
        if (json === null || json === '') return [];
        try {
            const value = JSON.parse(json);
            return Array.isArray(value) ? (value as T[]) : [];
        } catch {
            return [];
        }
    }

    const genres = (json: string | null) =>
        parse<Genre>(json)
            .map(genreLabel)
            .filter((label) => label !== '');

    const audios = (json: string | null) => parse<Audio>(json).map(audioLabel);

    const video = (program: { video_resolution: string | null; video_type: string | null }) =>
        videoLabel(program.video_resolution, program.video_type);

    const serviceName = (id: number) => data.services.find((s) => s.id === id)?.name ?? '';

    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS' };
    const HOUR = 60 * 60 * 1000;
    /** 5分を1マスにする。細かすぎると行数が増えるだけ、粗いと短い番組が潰れる */
    const SLOT = 5 * 60 * 1000;

    const slots = $derived((data.hours * HOUR) / SLOT);

    /** いま何時か。番組表に現在位置の線を出すため、1分ごとに進める */
    let clock = $state(Date.now());
    $effect(() => {
        const timer = setInterval(() => (clock = Date.now()), 60_000);
        return () => clearInterval(timer);
    });

    /** 表示中の日にいまが含まれていれば、その行 */
    const nowRow = $derived(
        clock >= data.start && clock < data.start + data.hours * HOUR
            ? Math.floor((clock - data.start) / SLOT) + 2
            : null,
    );

    let grid = $state<HTMLElement | null>(null);
    let nowMark = $state<HTMLElement | null>(null);

    // 開いたときに「いま」が見えている状態にする。24時間ぶん出るので、
    // 先頭(4:00)のままだと毎回スクロールさせることになる
    let scrolled = false;
    $effect(() => {
        if (scrolled || grid === null || nowMark === null) return;
        scrolled = true;
        // 「いま」を上端ちょうどに置くと直前の番組が見えず、放送中のものが
        // 頭から切れて分かりにくい。画面の4分の1あたりに来るようにする
        grid.scrollTop = Math.max(0, nowMark.offsetTop - grid.clientHeight / 4);
    });

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
    <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-2xl font-bold">番組表</h1>
        <div
            class="badge badge-lg {data.mirakurun.ok ? 'badge-success' : 'badge-error'}"
            data-testid="status"
        >
            Mirakurun {data.mirakurun.ok ? (data.mirakurun.version ?? 'OK') : 'NG'}
        </div>
        <div class="badge badge-lg badge-ghost">番組 {data.counts.programs} / 局 {data.counts.services}</div>
        <!-- 番組表が古いと気づくのはこの画面なので、取り直すのもここに置く -->
        <form method="POST" action="?/sync" use:submitting>
            <button class="btn btn-sm" data-testid="sync-button">EPGを今すぐ取得</button>
        </form>
        {#if form?.sync}
            <span class="text-sm" data-testid="sync-result">
                局 {form.sync.services} / 番組 {form.sync.programs} / 新規予約 {form.sync.reserved}
            </span>
        {/if}
    </div>
    <!--
        検索と条件の編集はルール画面に寄せてある。条件を2箇所で書けるようにすると
        判定がずれるので、ここは番組表の閲覧だけにする
    -->
    <form method="GET" action="/rules" class="flex flex-wrap items-end gap-2" data-testid="guide-filter">
        <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">番組を探す</span>
            <input
                type="search"
                name="keyword"
                placeholder="全チャンネルから探す"
                class="input input-bordered"
                data-testid="filter-keyword"
            />
        </label>
        <button class="btn btn-primary" type="submit">検索</button>
    </form>
</div>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="guide-error">{form.message}</div>
{/if}

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
        bind:this={grid}
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

            {#if nowRow !== null}
                <div
                    class="border-error pointer-events-none relative z-10 border-t-2"
                    style="grid-column: 1 / -1; grid-row: {nowRow};"
                    bind:this={nowMark}
                    data-testid="now-line"
                >
                    <span
                        class="bg-error text-error-content absolute -top-2 left-0 rounded px-1 text-[10px] leading-4"
                    >
                        {time(clock)}
                    </span>
                </div>
            {/if}

            {#each data.programs as program (program.id)}
                {@const pos = place(program)}
                <div
                    class="overflow-hidden p-0.5"
                    style="grid-column: {columnOf.get(
                        program.service_id,
                    )}; grid-row: {pos.row} / span {pos.span};"
                    data-testid="grid-program"
                    data-program-id={program.id}
                    data-service-id={program.service_id}
                    data-start-at={program.start_at}
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
                            {#if program.name}
                                {program.name}
                            {:else}
                                <span class="text-base-content/40">(番組情報なし)</span>
                            {/if}
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

{#if selected}
    <div class="modal modal-open" role="dialog" data-testid="program-detail">
        <div class="modal-box max-w-2xl">
            <h3 class="text-lg font-bold">{selected.name}</h3>
            <p class="text-base-content/60 mt-1 text-sm">
                {serviceName(selected.service_id)} ・ {dateTime(selected.start_at)} 〜 {time(selected.end_at)}
                ({duration(selected.start_at, selected.end_at)})
            </p>

            <!-- EPG が持っている符号は、そのままでは読めないので言葉に直して出す -->
            <div class="mt-2 flex flex-wrap gap-1" data-testid="detail-badges">
                {#each genres(selected.genre_detail) as label (label)}
                    <span class="badge badge-sm badge-ghost" data-testid="detail-genre">{label}</span>
                {/each}
                {#if video(selected)}
                    <span class="badge badge-sm badge-ghost" data-testid="detail-video">
                        {video(selected)}
                    </span>
                {/if}
                {#each audios(selected.audios) as label, i (i)}
                    <span class="badge badge-sm badge-ghost" data-testid="detail-audio">{label}</span>
                {/each}
                {#if !selected.is_free}
                    <span class="badge badge-sm badge-warning" data-testid="detail-paid">有料</span>
                {/if}
            </div>

            {#if selected.description}
                <p class="mt-3 text-sm whitespace-pre-wrap">{selected.description}</p>
            {/if}

            {#each extended(selected.extended) as [heading, body] (heading)}
                <div class="mt-3">
                    <div class="text-sm font-medium">{heading}</div>
                    <div class="text-base-content/70 text-sm whitespace-pre-wrap">{body}</div>
                </div>
            {/each}

            {#if selected.reservation_state}
                <div class="modal-action items-center">
                    <span class="badge badge-info" data-testid="detail-state">
                        {stateLabel(selected.reservation_state)}
                    </span>
                    <button class="btn" onclick={() => (selected = null)} data-testid="detail-close">
                        閉じる
                    </button>
                    <!-- 予約したあと番組表から止められないと、わざわざ予約一覧まで行くことになる -->
                    <form
                        method="POST"
                        action="?/cancel"
                        use:submitting={() =>
                            async ({ update }) => {
                                await update();
                                selected = null;
                            }}
                    >
                        <input type="hidden" name="programId" value={selected.id} />
                        <button class="btn btn-error btn-outline" data-testid="detail-cancel">
                            予約を取り消す
                        </button>
                    </form>
                </div>
            {:else}
                <form
                    method="POST"
                    action="?/reserve"
                    class="mt-4 flex flex-col gap-3"
                    use:submitting={() =>
                        async ({ update }) => {
                            await update();
                            selected = null;
                        }}
                >
                    <input type="hidden" name="programId" value={selected.id} />
                    <input type="hidden" name="options" value="1" />
                    <!-- 既定のままでいいことがほとんどなので畳んでおく -->
                    <details class="border-base-300 rounded-box border">
                        <summary
                            class="cursor-pointer px-3 py-2 text-sm font-medium"
                            data-testid="reserve-options-summary"
                        >
                            この番組の録画のしかた
                            <span class="text-base-content/60">(開かなければ既定のまま)</span>
                        </summary>
                        <div class="grid gap-3 px-3 pb-3 sm:grid-cols-2" data-testid="reserve-options">
                            <label class="flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="encode"
                                    value="on"
                                    checked
                                    class="checkbox checkbox-sm"
                                    data-testid="reserve-encode"
                                />
                                <span class="text-sm">エンコードする</span>
                            </label>
                            <label class="flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="keepOriginal"
                                    class="checkbox checkbox-sm"
                                    data-testid="reserve-keep"
                                />
                                <span class="text-sm">生TSも残す</span>
                            </label>
                            <!-- コーデックとCMの扱いは全体で1つ -->
                            <span class="text-base-content/60 text-xs sm:col-span-2">
                                コーデックとCMの扱いは<a class="link" href="/settings">設定</a>で決めます ({data.defaults.codec.toUpperCase()}
                                / CM: {CM_LABEL[data.defaults.cmCut]})
                            </span>
                        </div>
                    </details>
                    <div class="modal-action mt-0">
                        <button class="btn" onclick={() => (selected = null)} data-testid="detail-close">
                            閉じる
                        </button>
                        <button class="btn btn-primary" data-testid="detail-reserve">予約する</button>
                    </div>
                </form>
            {/if}
        </div>
        <button class="modal-backdrop" onclick={() => (selected = null)} aria-label="閉じる"></button>
    </div>
{/if}
