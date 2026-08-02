<script lang="ts">
    import { submitting } from '$lib/actions';
    import LogoArea from '$lib/components/LogoArea.svelte';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { detectPlatform, type Platform, playLinks, withCredentials } from '$lib/play';
    import {
        badgeClass,
        date,
        dateTime,
        duration,
        encodeLabel,
        eta,
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
     * どのプレイヤーに渡すか。UA だけで分かる分はサーバが決めて渡してくる
     * (ブラウザで判定してから出すと、読み込み直後に再生ボタンが一瞬消える)。
     *
     * iPad だけは UA で Macintosh を名乗るので、ここでタッチ点数を見て直す。
     * origin も同じ理由でサーバの値から始める
     */
    let refined = $state<{ platform: Platform; origin: string } | null>(null);
    $effect(() => {
        refined = {
            platform: detectPlatform(navigator.userAgent, navigator.maxTouchPoints),
            origin: location.origin,
        };
    });
    const platform = $derived(refined?.platform ?? data.platform);
    const origin = $derived(refined?.origin ?? data.origin);

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
    /** その行で検出したCM区間。長いので一覧には出さず、詳細でだけ見せる */
    let detailCm = $state<string | null>(null);
    /** 何で検出したか。ロゴが効いているかどうかがここで分かる */
    let detailCmNote = $state<string | null>(null);
    /** ロゴを当てられなかった録画。詳細で位置を教えてもらう */
    let detailLogo = $state<{
        recordingId: number;
        serviceId: number;
        serviceName: string;
        area: string | null;
    } | null>(null);

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
        cm: string | null = null,
        logo: typeof detailLogo = null,
        cmNote: string | null = null,
    ): Promise<void> {
        const token = ++opened;
        detailError = error;
        detailCm = cm;
        detailLogo = logo;
        detailCmNote = cmNote;
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

    /**
     * 行のどこを押しても、その行でいちばんやりたいことをする。
     * ボタンやリンクを押したときは邪魔しない。
     *
     * 録画なら**再生**。一覧を開くのは観るためなので、そこを1回で通す。
     * 中身を読みたいときは行の中の「詳細」から。
     * 予約は再生するものが無いので、そのまま詳細を出す。
     */
    function rowClick(event: MouseEvent | KeyboardEvent, play: string | null, open: () => void): void {
        if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
        if ((event.target as HTMLElement).closest('a, button, input, label')) return;
        if (play !== null) location.href = play;
        else open();
    }

    /** その録画をいま再生できるなら、プレイヤーに渡すURL */
    function playHref(rec: (typeof data.recordings)[number]): string | null {
        if (!playable(rec)) return null;
        return playLinks(fileUrl(rec.id), rec.name, platform, data.credentials)[0]?.href ?? null;
    }

    /**
     * 観られる録画かどうか。
     *
     * **失敗したものは観られない。** 途中まで書けたファイルが残っていることは
     * あるが、頭からスクランブルが掛かっていたり中身が空だったりで、押しても
     * プレイヤーが黙って閉じるだけだった。録り直しの口も同じ理由で出さない
     * (元になる生TSが使えないので、やり直しても同じところで失敗する)
     */
    function playable(rec: (typeof data.recordings)[number]): boolean {
        return (
            rec.deleted_at === null && rec.state !== 'failed' && (rec.library_path ?? rec.ts_path) !== null
        );
    }

    /** ロゴを当てられなかった録画だけ、詳細に位置の指定を出す */
    function logoOf(rec: (typeof data.recordings)[number]): typeof detailLogo {
        if (!rec.logo_missing || rec.deleted_at !== null) return null;
        return {
            recordingId: rec.id,
            serviceId: rec.service_id,
            serviceName: rec.service_name,
            area: rec.logo_area,
        };
    }

    /** 録画の詳細。失敗の理由は録画そのものとエンコードの両方が出るようにする */
    function openRecording(rec: (typeof data.recordings)[number]): void {
        /*
         * 録画が失敗した理由 (recordings.error) と、エンコードが失敗した理由
         * (encode_jobs.error) は別物。以前は後者しか渡していなかったので、
         * 録画そのものが失敗した行は詳細を開いても何も出なかった
         */
        const reason = [rec.state === 'failed' ? rec.error : null, rec.encode_error]
            .filter(Boolean)
            .join('\n\n');
        void openDetail(rec.program_id, rec, reason || null, rec.cm_ranges, logoOf(rec), rec.cm_note);
    }
</script>

<!--
    予約も録画も、行の形を揃える。

    以前は列に分けた表だった。状態も日時もサイズも1列ずつ持たせていたので、
    タブレットくらいの幅で表そのものが横スクロールになり、番組名が隠れていた。
    列を減らすと今度は画面ごとに出るものが違ってしまう。

    そこで**どの幅でも同じ1つの形**にした。左に「状態 + 番組名 + その他ぜんぶ」、
    右に押すもの。狭いところでは押すものが下へ回り込むだけで、出るものは変わらない。
    押すものは指で押せる大きさ (既定の btn) にしてある
-->
{#snippet title(state: string, badge: string, name: string, testid: string)}
    <div class="flex flex-wrap items-center gap-2">
        <span class="badge whitespace-nowrap {badge}" data-testid={testid}>{state}</span>
        <span class="font-medium break-words">{name}</span>
    </div>
{/snippet}

<!-- 局名・放送日時・尺・サイズ。1行にまとめて、空のものは出さない -->
{#snippet meta(parts: string[])}
    <div class="text-base-content/60 mt-1 text-sm break-words">
        {parts.filter(Boolean).join(' ・ ')}
    </div>
{/snippet}

<!--
    広い画面では2つの一覧を横に並べ、画面の残りを丁度使い切る。
    高さをJSで測って入れていた頃は、測る前の当ての値で一度描かれるので
    読み込むたびに一覧が縮んだ状態から伸びて見えた。ここは全部 CSS で決める。

    畳まれる幅 (lg 未満) では素直にページごとスクロールさせる。
    小さい画面で中だけスクロールさせると、指の届く範囲が二重になって使いづらい
-->
<div class="lg:flex lg:h-full lg:flex-col">
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

    <div class="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-5">
        <!--
        min-w-0 が無いと、中の表の幅にグリッドの列が引きずられてページごとはみ出す。
        1列に畳まれたときは録画を先に出す(見るのはたいてい録れたほうなので)
    -->
        <section class="order-2 min-w-0 lg:order-none lg:col-span-2 lg:flex lg:min-h-0 lg:flex-col">
            <div class="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
                <h2 class="text-lg font-bold">予約</h2>
                <!--
                    「競合を再計算」は置いていない。番組表を取り直したときとルールを
                    いじったときに必ず走るので、押す機会が無かった
                -->
                <a class="btn btn-sm" href={data.showFinished ? '/' : '/?all=1'}>
                    {data.showFinished ? '進行中のみ' : '完了分も表示'}
                </a>
            </div>

            <!--
            残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
            片方が長いともう片方が下に置いていかれるため
        -->
            <div class="overflow-auto rounded-box bg-base-100 shadow lg:min-h-0 lg:flex-1">
                <div class="divide-base-300 divide-y" data-testid="reservation-list">
                    {#each data.reservations as res (res.id)}
                        <!-- 行を押すと番組表と同じ詳細が出る -->
                        <div
                            data-testid="reservation-row"
                            data-reservation-id={res.id}
                            data-program-id={res.program_id}
                            class="hover:bg-base-200/60 relative cursor-pointer p-3"
                            role="button"
                            tabindex="0"
                            onclick={(event) => rowClick(event, null, () => openDetail(res.program_id, res))}
                            onkeydown={(event) =>
                                rowClick(event, null, () => openDetail(res.program_id, res))}
                        >
                            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
                                <div class="min-w-0 flex-1 basis-56" data-testid="row-body">
                                    {@render title(
                                        stateLabel(res.state),
                                        badgeClass(res.state),
                                        res.name,
                                        'reservation-state',
                                    )}
                                    {@render meta([
                                        res.service_name,
                                        `${dateTime(res.start_at)}〜${time(res.end_at)} (${duration(res.start_at, res.end_at)})`,
                                    ])}
                                    {#if res.conflict_reason}
                                        <div class="text-error mt-0.5 text-sm">{res.conflict_reason}</div>
                                    {/if}
                                    <!-- 手動なら何も出さない。既定と違うときだけ言う -->
                                    {#if !res.manual}
                                        <!-- ルール名をそのまま入口にする。行にボタンを足すと窮屈になる -->
                                        <div
                                            class="text-base-content/60 mt-0.5 text-xs"
                                            data-testid="rule-name"
                                        >
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
                                        <div class="mt-1 flex flex-wrap gap-1">
                                            {#if !res.encode}
                                                <span class="badge badge-ghost badge-sm">TSのみ</span>
                                            {/if}
                                            {#if res.keep_original}
                                                <span class="badge badge-ghost badge-sm">生TSも残す</span>
                                            {/if}
                                        </div>
                                    {/if}
                                </div>

                                <div class="flex shrink-0 flex-wrap items-center gap-2">
                                    {#if active.includes(res.state)}
                                        <form method="POST" action="?/cancel" use:submitting>
                                            <input type="hidden" name="id" value={res.id} />
                                            <button
                                                class="btn btn-error btn-outline"
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
                                            <button class="btn" data-testid="restore-button">戻す</button>
                                        </form>
                                    {/if}
                                </div>
                            </div>
                        </div>
                    {:else}
                        <div class="text-base-content/60 p-3">予約はありません</div>
                    {/each}
                </div>
            </div>
        </section>

        <section class="order-1 min-w-0 lg:order-none lg:col-span-3 lg:flex lg:min-h-0 lg:flex-col">
            <!-- 見出しの高さと下の余白は予約側と揃える。並べたときにずれて見えるため -->
            <div class="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
                <h2 class="text-lg font-bold">録画</h2>
                <div class="flex gap-2">
                    <a class="btn btn-sm" href={data.showDeleted ? '/' : '/?deleted=1'}>
                        {data.showDeleted ? '削除済みを隠す' : '削除済みも表示'}
                    </a>
                    <form method="POST" action="?/reconcile" use:submitting>
                        <button class="btn btn-sm" data-testid="reconcile-button">実体と照合</button>
                    </form>
                </div>
            </div>

            <!--
            残りいっぱいまで伸ばして、中だけスクロールさせる。2つ並べたときに、
            片方が長いともう片方が下に置いていかれるため
        -->
            <div class="overflow-auto rounded-box bg-base-100 shadow lg:min-h-0 lg:flex-1">
                <div class="divide-base-300 divide-y" data-testid="recording-list">
                    {#each data.recordings as rec (rec.id)}
                        <!--
                            理由はいま失敗している行にだけ出す。「エラーが残っているか」を
                            error 列だけで決めていた頃は、録り直して成功しても赤い文字が
                            残っていた。削除済みの行では error に削除理由が入る (赤くしない)。

                            録り直しの元になるのは生TS。エンコード済みを元にしても画質は
                            戻らないので、生TSがあるときだけ出す。
                            録画中は元がまだ書かれている最中なので触らせない
                        -->
                        {@const failing = rec.error && (rec.state === 'failed' || rec.deleted_at !== null)}
                        {@const canReencode =
                            playable(rec) && rec.job_id === null && encodeSource(rec) !== null}
                        <!-- 行を押すと番組表と同じ詳細が出る -->
                        <div
                            data-testid="recording-row"
                            data-recording-id={rec.id}
                            data-program-id={rec.program_id}
                            data-library-path={rec.library_path}
                            data-duration-ms={rec.duration_ms}
                            class="hover:bg-base-200/60 relative cursor-pointer p-3"
                            role="button"
                            tabindex="0"
                            onclick={(event) => rowClick(event, playHref(rec), () => openRecording(rec))}
                            onkeydown={(event) => rowClick(event, playHref(rec), () => openRecording(rec))}
                        >
                            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
                                <div class="min-w-0 flex-1 basis-56" data-testid="row-body">
                                    <!-- 消したものは「視聴可能」のままだと嘘になる。
                                         行は履歴として残るので、状態のほうを差し替える -->
                                    {@render title(
                                        rec.deleted_at !== null
                                            ? '削除済み'
                                            : (encodeLabel(
                                                  rec.job_state === null
                                                      ? null
                                                      : { state: rec.job_state, phase: rec.job_phase },
                                              ) ?? stateLabel(rec.state)),
                                        rec.deleted_at === null
                                            ? badgeClass(rec.job_state ?? rec.state)
                                            : 'badge-ghost',
                                        rec.name,
                                        'recording-state',
                                    )}
                                    <!--
                                        放送日時・尺・サイズは1行にまとめる。列に分けていた頃は、
                                        画面が狭いと表ごと横スクロールになって番組名まで隠れていた。
                                        ファイルの置き場所は普段は見ないので出さない (data-library-path)
                                    -->
                                    {@render meta([
                                        rec.service_name,
                                        // 番組表の尺ではなく実際に録れた長さ。
                                        // 途中で止めたときやCMを切ったときは合わない
                                        `${dateTime(rec.start_at)} (${recordedDuration(rec)})`,
                                        size(rec.ts_size),
                                        rec.deleted_at !== null ? `${date(rec.deleted_at)} に削除` : '',
                                    ])}
                                    <!--
                                        録り直しは失敗の理由の**左**に並べる。右端のボタンの列に
                                        置いていた頃は、失敗した行からいちばん遠い場所に押すものがあった
                                    -->
                                    {#if failing || canReencode}
                                        <div class="mt-1 flex flex-wrap items-center gap-2">
                                            {#if canReencode}
                                                <form method="POST" action="?/reencode" use:submitting>
                                                    <input type="hidden" name="id" value={rec.id} />
                                                    <button class="btn btn-sm" data-testid="reencode-button">
                                                        再エンコード
                                                    </button>
                                                </form>
                                            {/if}
                                            {#if failing}
                                                <span
                                                    class="line-clamp-2 text-sm {rec.deleted_at === null
                                                        ? 'text-error'
                                                        : 'text-base-content/60'}"
                                                    data-testid="recording-error"
                                                >
                                                    {rec.error}
                                                </span>
                                            {/if}
                                        </div>
                                    {/if}
                                    <!-- CM をどこで検出したかは行に出さない。長くて場所を食う割に
                                         普段は見ないので、行を押したときの詳細に回す -->
                                    {#if rec.logo_missing && rec.deleted_at === null}
                                        <!--
                                            ロゴを当てられなかったので、無音だけでCMを判定している。
                                            精度が落ちているのを黙っていると「なぜか切れていない」に
                                            なるので出す。押すと位置を教えられる
                                        -->
                                        <div class="text-warning mt-0.5 text-sm" data-testid="logo-missing">
                                            ロゴ未検出 (無音のみで判定)
                                            <span class="text-base-content/60"
                                                >— 押すと位置を教えられます</span
                                            >
                                        </div>
                                    {/if}
                                    <!--
                                        エンコード中だけ、割合と残りの見込みを添える。
                                        ffmpeg が回っていない段階 (解除中・CM検出中) は
                                        進み具合が取れないので、状態だけを出す
                                    -->
                                    {#if rec.job_state === 'running' && rec.job_phase === 'encode'}
                                        <div
                                            class="text-base-content/60 mt-0.5 text-xs"
                                            data-testid="encode-progress"
                                        >
                                            {percent(rec.job_percent ?? 0)}
                                            {#if eta(rec.job_eta_ms)}・{eta(rec.job_eta_ms)}{/if}
                                        </div>
                                    {/if}
                                </div>

                                <div class="flex shrink-0 flex-wrap items-center gap-2">
                                    <!--
                                        中身を読むのはこちら。行を押すと再生に行くので、
                                        番組の説明やCMの位置を見たいときの入口を別に置く
                                    -->
                                    <button
                                        type="button"
                                        class="btn btn-ghost"
                                        onclick={() => openRecording(rec)}
                                        data-testid="detail-button"
                                    >
                                        詳細
                                    </button>
                                    {#if rec.deleted_at === null}
                                        <!--
                                            まだエンコードしていないものや、引き継いだ未エンコードの
                                            録画は生TSしか無い。配信は library_path ?? ts_path を返すので、
                                            どちらかがあれば開ける。
                                            失敗した録画には出さない (playable)
                                        -->
                                        {#if playable(rec)}
                                            <!--
                                                ブラウザは MPEG-2 も AV1+Opus の mkv も素直には再生できない。
                                                端末に入っているプレイヤーに URL を渡して開かせる
                                            -->
                                            {#each playLinks(fileUrl(rec.id), rec.name, platform, data.credentials) as link (link.href)}
                                                <a
                                                    class="btn btn-primary"
                                                    href={link.href}
                                                    data-testid="play-link"
                                                    title={link.note ?? ''}
                                                >
                                                    {link.label}
                                                </a>
                                            {/each}
                                            <a
                                                class="btn btn-ghost"
                                                href={downloadUrl(rec.id)}
                                                download
                                                data-testid="download-link"
                                            >
                                                ダウンロード
                                            </a>
                                        {/if}
                                        {#if rec.job_id !== null}
                                            <!--
                                                動いている間は中止だけ。この裏で ffmpeg が
                                                元のTSを読んでいるので、消させると道連れになる
                                            -->
                                            <form method="POST" action="?/cancelEncode" use:submitting>
                                                <input type="hidden" name="id" value={rec.job_id} />
                                                <button
                                                    class="btn btn-error btn-outline"
                                                    data-testid="encode-cancel"
                                                >
                                                    エンコード中止
                                                </button>
                                            </form>
                                        {:else}
                                            <form method="POST" action="?/delete" use:submitting>
                                                <input type="hidden" name="id" value={rec.id} />
                                                {#if armed === rec.id}
                                                    <!-- 幅が変わるとボタンが動いて押し間違える。2文字で揃える -->
                                                    <button
                                                        class="btn btn-error"
                                                        data-testid="delete-confirm"
                                                    >
                                                        確定
                                                    </button>
                                                {:else}
                                                    <button
                                                        type="button"
                                                        class="btn btn-error btn-outline"
                                                        onclick={() => arm(rec.id)}
                                                        data-testid="delete-button"
                                                    >
                                                        削除
                                                    </button>
                                                {/if}
                                            </form>
                                        {/if}
                                    {/if}
                                </div>
                            </div>

                            <!--
                                進み具合は行の下端いっぱいに敷く。別の行に分けていた頃は、
                                行と行の間に隙間ができて、どの録画のものか分かりにくかった。

                                ffmpeg が回っていない段階でも割合を出すようにしたが、
                                取れないものもあるので、そのときは動いているだけのバーにする
                            -->
                            {#if rec.job_id !== null}
                                <progress
                                    class="progress progress-primary absolute inset-x-0 bottom-0 h-1 w-full rounded-none"
                                    value={rec.job_state === 'running' && (rec.job_percent ?? 0) > 0
                                        ? rec.job_percent
                                        : undefined}
                                    max="1"
                                    data-testid="encode-bar"
                                ></progress>
                            {/if}
                        </div>
                    {:else}
                        <div class="text-base-content/60 p-3">録画はありません</div>
                    {/each}
                </div>
            </div>
        </section>
    </div>
</div>

{#if detail}
    <ProgramDetail
        program={detail}
        error={detailError}
        cm={detailCm}
        cmNote={detailCmNote}
        onclose={() => (detail = null)}
    >
        {#snippet extra()}
            <!--
                ロゴを当てられなかった録画だけ。囲ってもらった位置は局ごとに覚えて、
                次にその局を録ったときから効く
            -->
            {#if detailLogo}
                <LogoArea
                    recordingId={detailLogo.recordingId}
                    serviceId={detailLogo.serviceId}
                    serviceName={detailLogo.serviceName}
                    area={detailLogo.area}
                />
            {/if}
        {/snippet}
    </ProgramDetail>
{/if}
