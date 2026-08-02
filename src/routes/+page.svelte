<script lang="ts">
    import { fillViewport, submitting } from '$lib/actions';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { detectPlatform, type Platform, playLinks, withCredentials } from '$lib/play';
    import {
        badgeClass,
        cmRanges,
        date,
        dateTime,
        duration,
        percent,
        recordedDuration,
        size,
        stateLabel,
        time,
    } from '$lib/format';
    import { encodeSource } from '$lib/source';
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
        // iPad は Macintosh を名乗るので、タッチ点数まで見ないと Mac と区別できない
        platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
        origin = location.origin;
    });

    /** プレイヤーに渡すので絶対URLにする */
    const fileUrl = (id: number) => `${origin}/api/recordings/${id}/file`;

    /*
     * ダウンロードも資格情報を URL に入れる。ブラウザは画面を開いたときの認証を
     * ダウンロードに引き継がないので、素のURLだと 401 になって落ちてこない。
     * ?download=1 でサーバが添付として返し、ファイル名も付く
     */
    const downloadUrl = (id: number) =>
        withCredentials(`${origin}/api/recordings/${id}/file?download=1`, data.credentials);

    /** 知らせを出しておく時間。読めるだけ出したら引っ込める */
    let notice = $state(false);
    $effect(() => {
        if (form?.message === undefined && form?.reconcile === undefined) return;
        notice = true;
        const timer = setTimeout(() => (notice = false), 6000);
        return () => clearTimeout(timer);
    });

    /** 行から開いた番組詳細。番組表と同じ見せ方をする */
    let detail = $state<Detail | null>(null);
    /** その行のエンコード失敗の理由。詳細の中で見せる */
    let detailError = $state<string | null>(null);

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
    async function openDetail(
        programId: number | null,
        row: Row,
        error: string | null = null,
    ): Promise<void> {
        const token = ++opened;
        detailError = error;
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

    /**
     * 削除は2回押させる。1回目で聞き返し、2回目で本当に消す。
     * 行のすぐ隣に並んでいるので、押し間違いで消えると取り返しがつかない。
     * 少し置いたら元に戻す(押したことを忘れた頃に消えないように)
     */
    let armed = $state<number | null>(null);
    let disarm: ReturnType<typeof setTimeout> | undefined;
    function arm(id: number): void {
        armed = id;
        clearTimeout(disarm);
        disarm = setTimeout(() => (armed = null), 5000);
    }

    /** 行のどこを押しても開く。ただしボタンやリンクを押したときは邪魔しない */
    function rowClick(
        event: MouseEvent | KeyboardEvent,
        programId: number | null,
        row: Row,
        error: string | null = null,
    ): void {
        if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
        if ((event.target as HTMLElement).closest('a, button, input, label')) return;
        void openDetail(programId, row, error);
    }
</script>

<h1 class="mb-4 text-2xl font-bold">予約と録画</h1>

<!--
    知らせは重ねて出す。一覧の上に差し込むと、その分だけ表が下にずれて
    画面からはみ出し、外側にスクロールバーが生える。
    ナビの下に置き、しばらくしたら自分で消える
-->
{#if notice}
    <div class="toast toast-top toast-center top-20 z-50">
        {#if form?.message}
            <div class="alert alert-error" data-testid="dashboard-error">{form.message}</div>
        {/if}
        {#if form?.reconcile}
            <div class="alert alert-info" data-testid="reconcile-result">
                照合 {form.reconcile.checked} 件 / 実体が無く削除済み {form.reconcile.removed} 件
            </div>
        {/if}
    </div>
{/if}

<div class="grid gap-6 lg:grid-cols-5">
    <!--
        min-w-0 が無いと、中の表の幅にグリッドの列が引きずられてページごとはみ出す。
        1列に畳まれたときは録画を先に出す(見るのはたいてい録れたほうなので)
    -->
    <section class="order-2 min-w-0 lg:order-none lg:col-span-2">
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

        <!--
            画面の残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
            片方が長いともう片方が下に置いていかれるため。
            高さは実測で決める(class の値はJSが動くまでの当て)
        -->
        <div class="overflow-auto rounded-box bg-base-100 max-h-[calc(100dvh-14rem)] shadow" use:fillViewport>
            <table class="table-pin-rows table table-zebra">
                <thead>
                    <tr>
                        <th class="whitespace-nowrap">放送日時</th>
                        <!-- 番組名は省略せずそのまま出す。余りはこの列に寄せる -->
                        <th class="w-full sm:min-w-48">番組</th>
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
                            <!-- 局名も種別も番組名の下に小さく。録画一覧と同じ出し方 -->
                            <td>
                                <div class="font-medium">{res.name}</div>
                                <div class="text-base-content/60 text-sm">{res.service_name}</div>
                                {#if res.conflict_reason}
                                    <div class="text-error text-sm">{res.conflict_reason}</div>
                                {/if}
                                <!-- 手動なら何も出さない。既定と違うときだけ言う -->
                                {#if !res.manual}
                                    <!-- ルール名をそのまま入口にする。行にボタンを足すと窮屈になる -->
                                    <div class="text-base-content/60 text-xs" data-testid="rule-name">
                                        ルール:
                                        {#if res.rule_id !== null}
                                            <a class="link" href="/rules?edit={res.rule_id}">
                                                {res.rule_name}
                                            </a>
                                        {:else}
                                            (削除済み)
                                        {/if}
                                    </div>
                                {/if}
                                {#if !res.encode || res.keep_original}
                                    <div class="mt-0.5 flex flex-wrap gap-1">
                                        {#if !res.encode}
                                            <span class="badge badge-ghost badge-sm">TSのみ</span>
                                        {/if}
                                        {#if res.keep_original}
                                            <span class="badge badge-ghost badge-sm">生TSも残す</span>
                                        {/if}
                                    </div>
                                {/if}
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
                                {:else if res.state === 'canceled' && res.end_at > Date.now()}
                                    <!--
                                        取り消した予約はルールが作り直さないので、
                                        気が変わったときに戻せるのはここだけ
                                    -->
                                    <form method="POST" action="?/restore" use:submitting>
                                        <input type="hidden" name="id" value={res.id} />
                                        <button class="btn btn-sm" data-testid="restore-button">
                                            戻す
                                        </button>
                                    </form>
                                {/if}
                            </td>
                        </tr>
                    {:else}
                        <tr><td colspan="4" class="text-base-content/60">予約はありません</td></tr>
                    {/each}
                </tbody>
            </table>
        </div>
    </section>

    <section class="order-1 min-w-0 lg:order-none lg:col-span-3">
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
                                        <form method="POST" action="?/cancelEncode" use:submitting>
                                            <input type="hidden" name="id" value={job.id} />
                                            <button
                                                class="btn btn-xs btn-error btn-outline"
                                                data-testid="encode-cancel"
                                            >
                                                中止
                                            </button>
                                        </form>
                                    </div>
                                </div>
                                <!-- 失敗したものはここには出ない。録画の行に出て、理由は詳細で見せる -->
                                <progress class="progress progress-primary w-full" value={job.percent} max="1"
                                ></progress>
                                <div class="text-base-content/60 text-xs">
                                    {percent(job.percent)}{#if job.log}・{job.log}{/if}
                                </div>
                            </li>
                        {/each}
                    </ul>
                </div>
            </div>
        {/if}

        <!--
            画面の残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
            片方が長いともう片方が下に置いていかれるため。
            高さは実測で決める(class の値はJSが動くまでの当て)
        -->
        <div class="overflow-auto rounded-box bg-base-100 max-h-[calc(100dvh-14rem)] shadow" use:fillViewport>
            <table class="table-pin-rows table table-zebra">
                <thead>
                    <tr>
                        <th class="whitespace-nowrap">放送日時</th>
                        <!-- 番組名は省略せずそのまま出す。余りはこの列に寄せる -->
                        <th class="w-full sm:min-w-48">番組</th>
                        <th class="hidden whitespace-nowrap sm:table-cell">サイズ</th>
                        <th class="whitespace-nowrap">状態</th>
                        <th class="text-right"></th>
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
                            data-duration-ms={rec.duration_ms}
                            class="hover cursor-pointer"
                            tabindex="0"
                            onclick={(event) => rowClick(event, rec.program_id, rec, rec.encode_error)}
                            onkeydown={(event) => rowClick(event, rec.program_id, rec, rec.encode_error)}
                        >
                            <td class="whitespace-nowrap">
                                {dateTime(rec.start_at)}
                                <!-- 番組表の尺ではなく実際に録れた長さ。
                                     途中で止めたときやCMを切ったときは合わない -->
                                <span class="text-base-content/60 text-xs">
                                    ({recordedDuration(rec)})
                                </span>
                            </td>
                            <td>
                                <div class="font-medium">{rec.name}</div>
                                <!-- ファイルの置き場所は普段は見ないので出さない。
                                     必要なときは data-library-path を見る -->
                                <div class="text-base-content/60 text-sm">{rec.service_name}</div>
                                {#if rec.error}
                                    <!--
                                        失敗したことはこの行に出し、理由は行を押して詳細で見せる。
                                        ffmpeg の出力は長いので一覧に貼ると読みづらい。
                                        削除済みの行では error 列に削除理由が入る。失敗ではないので赤くしない
                                    -->
                                    <div
                                        class="line-clamp-2 text-sm {rec.deleted_at === null
                                            ? 'text-error'
                                            : 'text-base-content/60'}"
                                        data-testid="recording-error"
                                    >
                                        {rec.error}
                                        {#if rec.encode_error}
                                            <span class="text-base-content/60">(押すと理由が出ます)</span>
                                        {/if}
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
                            <td class="hidden whitespace-nowrap sm:table-cell">{size(rec.ts_size)}</td>
                            <td class="whitespace-nowrap">
                                <!-- 消したものは「視聴可能」のままだと嘘になる。
                                     行は履歴として残るので、状態のほうを差し替える -->
                                <span
                                    class="badge whitespace-nowrap {rec.deleted_at === null
                                        ? badgeClass(rec.state)
                                        : 'badge-ghost'}"
                                    data-testid="recording-state"
                                >
                                    {rec.deleted_at === null ? stateLabel(rec.state) : '削除済み'}
                                </span>
                            </td>
                            <!--
                                広い画面では畳ませない(縦積みになる)。狭い画面では畳ませる。
                                右端に寄せる。再生ボタンが出ない行でも削除の位置が揃う
                            -->
                            <td class="sm:whitespace-nowrap">
                                <div class="flex flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
                                    {#if rec.deleted_at === null}
                                        <!--
                                            まだエンコードしていないものや、引き継いだ未エンコードの
                                            録画は生TSしか無い。配信は library_path ?? ts_path を返すので、
                                            どちらかがあれば開ける
                                        -->
                                        {#if (rec.library_path ?? rec.ts_path) !== null && platform !== null}
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
                                                href={downloadUrl(rec.id)}
                                                download
                                                data-testid="download-link"
                                            >
                                                ダウンロード
                                            </a>
                                        {/if}
                                        <!--
                                            元になるのは生TS。エンコード済みを元に録り直しても
                                            画質は戻らないので、生TSがあるときだけ出す。
                                            録画中・エンコード中は元がまだ書かれている最中なので触らせない
                                        -->
                                        {#if encodeSource(rec) !== null && rec.state !== 'recording' && rec.state !== 'encoding'}
                                            <form method="POST" action="?/reencode" use:submitting>
                                                <input type="hidden" name="id" value={rec.id} />
                                                <button class="btn btn-sm" data-testid="reencode-button"
                                                    >再エンコード</button
                                                >
                                            </form>
                                        {/if}
                                        <form method="POST" action="?/delete" use:submitting>
                                            <input type="hidden" name="id" value={rec.id} />
                                            {#if armed === rec.id}
                                                <button
                                                    class="btn btn-sm btn-error"
                                                    data-testid="delete-confirm"
                                                >
                                                    本当に削除
                                                </button>
                                            {:else}
                                                <button
                                                    type="button"
                                                    class="btn btn-sm btn-error btn-outline"
                                                    onclick={() => arm(rec.id)}
                                                    data-testid="delete-button"
                                                >
                                                    削除
                                                </button>
                                            {/if}
                                        </form>
                                    {:else}
                                        <!--
                                            消したものにはファイルが無いので、押せるものは何もない。
                                            空欄のままだと列が崩れて「出るはずのものが出ていない」に
                                            見えるので、いつ消したかを同じ場所に出す
                                        -->
                                        <span class="text-base-content/60 text-sm" data-testid="deleted-at">
                                            {date(rec.deleted_at!)} に削除
                                        </span>
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
    <ProgramDetail program={detail} error={detailError} onclose={() => (detail = null)} />
{/if}
