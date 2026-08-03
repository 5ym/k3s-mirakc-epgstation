<script lang="ts">
    import { preloadData } from '$app/navigation';
    import { dragScroll, submitting } from '$lib/actions';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import { genreTint, stateLabel, time } from '$lib/format';
    import { detectPlatform, type Platform, playLinks, withCredentials } from '$lib/play';

    let { data, form } = $props();

    // 検索条件はURLに持たせる。そのままルールにできるようにするため

    /** クリックした番組。詳細を出してから予約するかどうか決める */
    let selected = $state<(typeof data.programs)[number] | null>(null);

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
    /**
     * チャンネル名の行の高さ。時刻を下ろしてくるときの上端に使う。
     * 決め打ちの値だと、局ロゴが入ったり字の大きさが変わったりしたときに
     * 数字が見出しの裏へ潜る
     */
    let headHeight = $state(0);

    /*
     * 開いたときに「いま」が見えている状態にする。24時間ぶん出るので、
     * 先頭(4:00)のままだと毎回スクロールさせることになる。
     *
     * 位置は offsetTop では測れない。offsetTop は「位置指定された親」からの距離で、
     * ここでは body が親になるため、ナビや見出しの高さまで足し込まれて
     * その分だけ下に行き過ぎる。実際に見えている位置の差から出す。
     */
    let scrolled = false;
    $effect(() => {
        if (scrolled || grid === null || nowMark === null) return;
        scrolled = true;

        const target = grid;
        const mark = nowMark;
        // 「いま」を上端ちょうどに置くと直前の番組が見えず、放送中のものが
        // 頭から切れて分かりにくい。画面の4分の1あたりに来るようにする
        const place = () => {
            const top = mark.getBoundingClientRect().top - target.getBoundingClientRect().top;
            target.scrollTop = Math.max(0, target.scrollTop + top - target.clientHeight / 4);
        };

        place();
        let frames = 0;
        const settle = () => {
            place();
            // 画像(局ロゴ)やバッジが入って高さが変わることがあるので数回追う
            if (++frames < 5) requestAnimationFrame(settle);
        };
        requestAnimationFrame(settle);
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

    const prevHref = $derived(href({ start: String(data.start - data.hours * HOUR) }));
    const nextHref = $derived(href({ start: String(data.start + data.hours * HOUR) }));

    /*
     * 放送波を切り替えたら横位置を先頭へ戻す。
     *
     * 同じ画面のまま中身だけ入れ替わるので、DOM は使い回され、横スクロールの
     * 位置がそのまま残る。地上波で右のほうを見ていたあと BS を開くと、
     * 局の並びは別物なのに同じ位置から始まり、左端の局が隠れていた。
     * 縦(時刻)はどの放送波でも同じ意味なので、そのままにする
     */
    $effect(() => {
        data.type;
        if (grid !== null) grid.scrollLeft = 0;
    });

    /*
     * 前日・翌日を先に取り寄せておく。
     *
     * 押してから読み込むと、24時間ぶんの番組を引き直して組み直す間だけ止まって見えた。
     * body の `data-sveltekit-preload-data="hover"` は指を乗せてからなので、
     * 狙って押すと間に合わない。表を出した時点で両隣を取っておけば、押した瞬間に出る。
     *
     * **開くのが終わってから**取りに行く。すぐ投げていた頃は、いま見たい番組表と
     * 前後2日ぶんを同時に取ることになり、初めの表示そのものが遅くなっていた。
     * requestIdleCallback は Safari に無いので、無ければ少し置いてから
     */
    $effect(() => {
        const soon = prevHref;
        const later = nextHref;
        const fetchBoth = () => {
            void preloadData(soon);
            void preloadData(later);
        };
        // requestIdleCallback は Safari に無い
        if (typeof requestIdleCallback !== 'function') {
            const timer = setTimeout(fetchBoth, 500);
            return () => clearTimeout(timer);
        }
        const handle = requestIdleCallback(fetchBoth, { timeout: 3000 });
        return () => cancelIdleCallback(handle);
    });

    /** 番組表からそのまま再生できるようにする。宛先の決め方は録画一覧と同じ */
    let refined = $state<{ platform: Platform; origin: string } | null>(null);
    $effect(() => {
        refined = {
            platform: detectPlatform(navigator.userAgent, navigator.maxTouchPoints),
            origin: location.origin,
        };
    });
    const platform = $derived(refined?.platform ?? data.platform);
    const origin = $derived(refined?.origin ?? data.origin);

    /** 予約を取り消せるのはこれから録るものだけ。録り終わったものに出しても何も起きない */
    const CANCELABLE = ['scheduled', 'conflict', 'recording'];
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
    <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-2xl font-bold">番組表</h1>
        <!-- 番組表が古いことに気づくのはこの画面なので、いま何件あるかは出す。
             mirakc 自体の状態は設定画面にまとめてある -->
        <div class="badge badge-lg badge-ghost" data-testid="counts">
            番組 {data.counts.programs} / 局 {data.counts.services}
        </div>
        <!--
            「EPGを今すぐ取得」は置いていない。mirakc が番組表を更新したら
            その場で知らせてくるので (docs/data.md)、押す前に入っている
        -->
    </div>
    <!--
        検索と条件の編集はルール画面に寄せてある。条件を2箇所で書けるようにすると
        判定がずれるので、ここは番組表の閲覧だけにする
    -->
    <form method="GET" action="/rules" class="flex flex-wrap items-end gap-2" data-testid="guide-filter">
        <label class="flex flex-col gap-1">
            <span class="text-sm font-medium">番組を探す</span>
            <!-- 探す範囲(番組名/概要/詳細)はルール画面で切り替えられる。既定は番組名だけ -->
            <input
                type="search"
                name="keyword"
                placeholder="全チャンネルの番組名から"
                class="input input-bordered"
                data-testid="filter-keyword"
            />
        </label>
        <button class="btn btn-primary" type="submit">検索</button>
    </form>
</div>

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
        <a class="btn btn-sm" href={prevHref} data-testid="prev-day">← 前日</a>
        <span class="text-sm" data-testid="window-label">
            <!-- 日本の番組表の慣習で、1日は4時から翌4時まで -->
            {dayLabel(data.start)} <span class="text-base-content/60">(4:00〜翌4:00)</span>
        </span>
        <a class="btn btn-sm" href={nextHref} data-testid="next-day">翌日 →</a>
        <a class="btn btn-sm" href={href({})}>今日</a>
    </div>
</div>

{#if data.services.length === 0}
    <div class="rounded-box bg-base-100 p-6 text-center shadow" data-testid="empty-grid">
        <p class="text-base-content/60">
            {TYPE_LABEL[
                data.type
            ]}のチャンネルがありません。チューナー画面でチャンネルスキャンを実行してください。
        </p>
    </div>
{:else}
    <div
        class="rounded-box bg-base-100 max-h-[75vh] cursor-grab overflow-auto shadow active:cursor-grabbing"
        use:dragScroll
        bind:this={grid}
        data-testid="guide-grid"
    >
        <!--
            **横幅を数えて入れておく。**

            列の合計 (5688px) より外側の枠が狭いままだと、grid はそこからはみ出して
            描かれるだけで、枠自体は画面の幅 (358px) のまま残る。`sticky` は
            親の枠から外へは出られない決まりなので、時刻の列は
            「画面の幅 − 列の幅」ぶんしか付いてこられず、そこから先は
            置いていかれていた (390px の端末だと 302px スクロールしたところで脱落)。

            幅を列の合計にしておけば、端まで付いてくる。局が少なくて画面のほうが
            広いときは min-width で伸ばし、余りは 1fr が分け合う
        -->
        <div
            class="grid"
            style="grid-template-columns: 3.5rem repeat({data.services
                .length}, minmax(11rem, 1fr)); grid-template-rows: auto repeat({slots}, 0.75rem); width: calc(3.5rem + {data
                .services.length} * 11rem); min-width: 100%;"
            data-testid="guide-rows"
        >
            <!-- 左上の角。時刻列とチャンネル行の交点で、どちらにも追従させる -->
            <div
                class="bg-base-100 border-base-300 sticky top-0 left-0 z-30 border-r"
                style="grid-column: 1; grid-row: 1;"
                bind:clientHeight={headHeight}
            ></div>
            {#each data.services as service, i (service.id)}
                <div
                    class="bg-base-100 border-base-300 sticky top-0 z-20 flex items-center gap-1.5 truncate border-b px-2 py-2 text-sm font-medium"
                    style="grid-column: {i + 2}; grid-row: 1;"
                    title={service.name}
                >
                    {#if service.has_logo}
                        <!--
                            ロゴを持たない局もあるので、有るものだけ出す。
                            列が印になっているだけで実体が無いこともある (置き場ごと
                            消えたとき)。取れなかったら黙って引っ込める
                        -->
                        <img
                            src="/api/services/{service.id}/logo"
                            alt=""
                            class="h-5 w-8 shrink-0 object-contain"
                            loading="lazy"
                            onerror={(event) => (event.currentTarget as HTMLImageElement).remove()}
                        />
                    {/if}
                    <span class="truncate">{service.name}</span>
                </div>
            {/each}

            <!--
                時刻の列。**横にも縦にも追従させる。**

                横は列そのものを `sticky left-0` で置いておけば済む。縦は
                そうはいかない。1マス(5分)ずつでは細かすぎるので1時間を1つの
                グリッド領域にしているが、そうすると数字はその領域の先頭に
                書かれるだけで、時間の途中まで下ろすと画面の外へ出てしまい、
                いま何時のところを見ているのか分からなくなっていた。

                中の数字をもう一段 `sticky` にして、その1時間ぶんの領域の中で
                下りてくるようにする。上端はチャンネル名の行のぶんだけ空ける
                (高さは実測する。決め打ちだと1pxずれて数字が見出しの裏へ潜る)
            -->
            {#each hourMarks as mark (mark.at)}
                <div
                    class="bg-base-100 border-base-300 sticky left-0 z-10 border-t border-r px-1 text-xs"
                    style="grid-column: 1; grid-row: {mark.row} / span {mark.span};"
                >
                    <span class="sticky block" style="top: {headHeight}px;">
                        {new Date(mark.at).getHours()}
                    </span>
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
                    <!--
                        マスは上ぞろえ。button は中身を縦中央に置くので、短い番組と
                        長い番組で開始時刻の高さが揃わず、横に目で追えなかった。
                        flex-col にして上から積む。

                        色はジャンル(大分類)ごとに変える。白黒のマスが敷き詰まっていると
                        どこに何があるのか目で追えない。予約したものだけは色より
                        「予約済み」であることのほうが大事なので、そちらを優先する
                    -->
                    <button
                        class="flex h-full w-full flex-col overflow-hidden rounded border-l-2 px-1 py-0.5 text-left {program.reservation_state
                            ? 'bg-primary/20 border-primary'
                            : genreTint(program.genres)}"
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
    {@const program = selected}
    <ProgramDetail
        program={{ ...program, service_name: serviceName(program.service_id) }}
        onclose={() => (selected = null)}
    >
        {#snippet actions()}
            <!--
                失敗の理由は詳細の中に出す。番組表にインラインで足すと、その分だけ
                グリッドが下にずれてスクロールバーが出る
            -->
            {#if form?.message}
                <div class="alert alert-error mt-4" data-testid="guide-error">{form.message}</div>
            {/if}
            <!--
                閉じるは**いちばん右で動かさない**。押すものが番組によって増えたり
                減ったりする (予約する / 取り消す / 再生 / ダウンロード) ので、
                そのたびに位置が変わると、閉じたつもりで別のものを押すことになる
            -->
            <div class="modal-action flex-wrap items-center justify-end">
                {#if program.reservation_state}
                    <span class="badge badge-info mr-auto" data-testid="detail-state">
                        {stateLabel(program.reservation_state)}
                    </span>
                {:else if program.end_at <= clock}
                    <!--
                        もう終わった番組。予約する口を出しても、押した先で
                        「放送が終わっています」と断られるだけ (reservations.reserve)
                    -->
                    <span class="badge badge-ghost mr-auto" data-testid="detail-ended">放送終了</span>
                {/if}

                {#if program.recording_id !== null && (program.library_path ?? program.ts_path) !== null}
                    <!--
                        録れているなら、ここからそのまま観られるようにする。
                        番組表で見つけた番組を観るのに、録画一覧へ戻って同じ番組を
                        探し直させるのは遠回り
                    -->
                    {#each playLinks(`${origin}/api/recordings/${program.recording_id}/file`, program.recording_name ?? program.name, platform, data.credentials) as link (link.href)}
                        <a
                            class="btn btn-primary"
                            href={link.href}
                            data-testid="detail-play"
                            title={link.note ?? ''}
                        >
                            {link.label}
                        </a>
                    {/each}
                    <a
                        class="btn btn-ghost"
                        href={withCredentials(
                            `${origin}/api/recordings/${program.recording_id}/file?download=1`,
                            data.credentials,
                        )}
                        download
                        data-testid="detail-download"
                    >
                        ダウンロード
                    </a>
                {/if}

                {#if CANCELABLE.includes(program.reservation_state ?? '')}
                    <!-- 予約したあと番組表から止められないと、わざわざ予約一覧まで行くことになる -->
                    <form
                        method="POST"
                        action="?/cancel"
                        use:submitting={() =>
                            async ({ result, update }) => {
                                await update();
                                if (result.type === 'success') selected = null;
                            }}
                    >
                        <input type="hidden" name="programId" value={program.id} />
                        <button class="btn btn-error btn-outline" data-testid="detail-cancel">
                            予約を取り消す
                        </button>
                    </form>
                {:else if program.reservation_state === null && program.end_at > clock}
                    <!--
                        録画のしかたはここでは選ばせない。設定画面の1箇所で決める
                        (同じ選択肢を予約・ルール・設定に並べると、どれで決まったのか
                        分からなくなる)
                    -->
                    <form
                        method="POST"
                        action="?/reserve"
                        use:submitting={() =>
                            async ({ result, update }) => {
                                await update();
                                // 失敗したときは開いたままにして、中に理由を出す
                                if (result.type === 'success') selected = null;
                            }}
                    >
                        <input type="hidden" name="programId" value={program.id} />
                        <button class="btn btn-primary" data-testid="detail-reserve">予約する</button>
                    </form>
                {/if}

                <!-- 位置を動かさないため、いつでもここが最後 -->
                <button class="btn" onclick={() => (selected = null)} data-testid="detail-close">
                    閉じる
                </button>
            </div>
        {/snippet}
    </ProgramDetail>
{/if}
