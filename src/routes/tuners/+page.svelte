<script lang="ts">
    import { submitting } from '$lib/actions';
    import LogoArea from '$lib/components/LogoArea.svelte';
    import Toasts, { type Notice } from '$lib/components/Toasts.svelte';
    import { held, liveUpdates } from '$lib/live-updates.svelte';

    let { data, form } = $props();

    // スキャンは数十分かかることがある。進み具合はサーバから push される。
    // 局の取り込みも1回では終わらないので、増えるたびに描き直す。
    // ロゴ取得も1チャンネルに数分かかるので、同じように流してもらう
    // 番組表を集めている最中の様子も 'tuners' で流れてくる
    liveUpdates(['scan', 'services', 'logos', 'tuners', 'programs']);
    const scan = $derived(data.scan);
    /** まだ覚えていない局だけ並べる。覚えている局に用は無い */
    const unlearned = $derived(data.cmLogos.filter((service) => !service.learned));

    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS' };
    /** チューナーが受けられる種別。設定の表で並べる順 */
    const TYPES = ['GR', 'BS', 'CS'] as const;
    const STATE_LABEL: Record<string, string> = {
        running: '実行中',
        done: '完了',
        failed: '失敗',
        canceled: '中断',
        idle: '待機中',
    };

    /** 進捗。総数が分かっているので割合で出せる */
    const progress = $derived(scan.total > 0 ? scan.scanned / scan.total : 0);

    /*
     * 物理チャンネルと、そこに乗っている局。**denpa 自身のDBから来る。**
     * エージェントにも控えはあるが、聞きに行かない (+page.server.ts)
     */
    const coverage = $derived(data.channels);
    /** そこに乗っている局の総数と、番組表が届いている局の数 */
    const services = $derived(coverage.flatMap((channel) => channel.services));

    /*
     * **読み直しの間も前の中身を出したままにする。**
     *
     * 知らせが来るたびに読み直しているが、相手待ちのものは promise のまま
     * 渡ってくるので、`{#await}` に直に食わせると読み直すたびに待ち状態へ戻り、
     * 表がいったん消えてから同じものが描き直されていた (目に見えてちらつく)。
     * 中身を持っておけば、実際に変わった行だけが変わる
     */
    const shownTuners = held(() => data.tuners);
    const shownCard = held(() => data.card);

    /** 番組表がどこまで埋まっているか。「8/9 まで」の形で出す */
    function until(at: number): string {
        const d = new Date(at);
        return `${d.getMonth() + 1}/${d.getDate()} まで`;
    }

    /** 押した結果。スキャンの経過そのものは下のカードに出したままにする */
    const notices = $derived.by(() => {
        const list: Notice[] = [];
        if (form?.message) list.push({ key: 'tuner-error', kind: 'error', text: form.message });
        if (form?.scan) list.push({ key: 'tuner-notice', kind: 'info', text: form.scan });
        return list;
    });
</script>

<h1 class="mb-4 text-2xl font-bold">チューナー</h1>

<Toasts {notices} source={form} />

<div class="grid items-start gap-6 xl:grid-cols-2">
    <div class="flex min-w-0 flex-col gap-6">
        <section class="card bg-base-100 shadow" data-testid="channel-card">
            <div class="card-body">
                <!--
                    **説明を3つ重ねない。**

                    見出しの下に長い前置き、ボタンの下に押し方の説明、数の下に
                    数え方の説明、と3つ並んでいた。どれも同じことを言い換えていて、
                    肝心の数が下に押し出されていた。**数を先に出して、注は1つだけ。**
                -->
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <h2 class="card-title">取れているチャンネル</h2>
                    <!--
                        入れたばかりのとき用。普段の周回は録画にもスキャンにもロゴにも
                        譲るので、何か動いていると番組表がなかなか埋まらない。
                        押されている間は録画以外を蹴って、全チューナーで回る
                    -->
                    <form method="POST" action="?/collectNow" use:submitting>
                        <button
                            class="btn btn-sm"
                            disabled={data.collect.boosted}
                            data-testid="epg-collect-now"
                        >
                            {data.collect.boosted ? '集めています…' : '番組表をいますぐ集める'}
                        </button>
                    </form>
                </div>
                {#if data.collect.running}
                    <!-- 1チャンネルに数分かかる。黙っていると止まって見える -->
                    <div class="text-base-content/70 text-sm" data-testid="epg-collect">
                        {data.collect.boosted ? '最優先で集めています' : '番組表を集めています'}
                        ({data.collect.active.join(', ') || '準備中'}) ・ 残り {data.collect.pending} チャンネル
                    </div>
                {/if}
                {#if coverage.length === 0}
                    <p class="text-base-content/60 text-sm" data-testid="channel-empty">
                        まだ1つもありません。チャンネルスキャンを実行してください。
                    </p>
                {:else}
                    <!-- 番組表がもう入っている局の数。下の表の右端を全部見なくても分かるように -->
                    {@const withEpg = services.filter((service) => service.programs > 0).length}
                    <!--
                        **入れ子になった3つの数を、その順に並べる。**

                        「50 / 59 ・ 124 局」とだけ出していた頃は、59 と 124 が
                        同じものの数に見えて「残り65はどこへ行った」となっていた。
                        この3つは入れ子で、数がそろわないのが当たり前:

                          周波数 (T19, BS15_0) ┬ 局 (TOKYO MX1) ─ 番組表
                                              └ 局 (TOKYO MX2) ─ 番組表

                        局と番組表を分けて出すのも、混ざりやすいから。
                        局はスキャンで、番組表はそのあと denpa が集めるもので、
                        埋まる時期がずれる (局はあるのに番組表が空、が普通にある)
                    -->
                    <div class="text-sm" data-testid="channel-coverage">
                        <span class="text-base-content/70">周波数</span>
                        <strong>{coverage.length} 本</strong>
                        <span class="text-base-content/40">→</span>
                        <span class="text-base-content/70">そこに乗っている局</span>
                        <strong>{services.length}</strong>
                        <span class="text-base-content/40">→</span>
                        <span class="text-base-content/70">番組表の届いた局</span>
                        <strong>{withEpg}</strong>
                    </div>
                    <!--
                        **注はここ1つだけ。** 数のすぐ下に、数がそろわない理由と、
                        上のボタンが何をするものかをまとめて置く
                    -->
                    <div class="text-base-content/60 text-xs">
                        1本の周波数に局が何局も相乗りしているので、本数と局数はそろいません。番組表は局ごとに、スキャンのあとを追って埋まります。
                        埋まるのを待てないときは<strong>「番組表をいますぐ集める」</strong
                        >で、空いているチューナーを全部使って集められます (録画は蹴りません)。
                    </div>
                    <div class="max-h-96 overflow-auto">
                        <table class="table-pin-rows table table-sm">
                            <thead>
                                <tr>
                                    <th>種別</th>
                                    <th>ch</th>
                                    <th class="w-full">局</th>
                                    <th class="whitespace-nowrap">番組表</th>
                                </tr>
                            </thead>
                            <tbody data-testid="channel-list">
                                {#each coverage as channel (`${channel.type}:${channel.channel}`)}
                                    {@const programs = channel.services.reduce(
                                        (sum, service) => sum + service.programs,
                                        0,
                                    )}
                                    {@const last = Math.max(
                                        0,
                                        ...channel.services.map((service) => service.until),
                                    )}
                                    <tr data-testid="channel-row" data-channel={channel.channel}>
                                        <td class="whitespace-nowrap text-sm">
                                            {TYPE_LABEL[channel.type] ?? channel.type}
                                        </td>
                                        <td class="font-mono text-sm whitespace-nowrap">
                                            {channel.channel}
                                        </td>
                                        <td class="text-sm">
                                            <div data-testid="channel-services">
                                                {channel.services.map((service) => service.name).join(', ')}
                                            </div>
                                        </td>
                                        <td class="text-sm whitespace-nowrap" data-testid="channel-epg">
                                            {#if programs > 0}
                                                <div>{programs} 件</div>
                                                <div class="text-base-content/60 text-xs">
                                                    {until(last)}
                                                </div>
                                            {:else}
                                                <span class="text-base-content/60">—</span>
                                            {/if}
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
            </div>
        </section>

        <section class="card bg-base-100 shadow" data-testid="scan-card">
            <div class="card-body">
                <h2 class="card-title">チャンネルスキャン</h2>
                <p class="text-base-content/70 text-sm">
                    受信できるチャンネルを実際に選局して探します。<strong
                        >空いているチューナーを全部使います</strong
                    >が、<strong>録画中でも実行できます</strong> (録画のほうが強いので、そのチューナーは 使いません)。見つかったものは保存され、終わると番組表も集め直します。
                </p>

                <form method="POST" action="?/scan" use:submitting class="mt-2 space-y-3">
                    <div>
                        <span class="text-sm font-medium">種別</span>
                        <div class="mt-1 flex flex-wrap gap-4" data-testid="scan-types">
                            {#each ['GR', 'BS', 'CS'] as type (type)}
                                <label class="flex cursor-pointer items-center gap-2">
                                    <input
                                        type="checkbox"
                                        name="types"
                                        value={type}
                                        checked={type === 'GR'}
                                        class="checkbox checkbox-sm"
                                    />
                                    <span class="text-sm">{TYPE_LABEL[type]}</span>
                                </label>
                            {/each}
                        </div>
                    </div>
                    <!--
                        探す範囲は決め打ち。放送で使う物理チャンネルは決まっていて、
                        狭めても総当たりの時間が少し減るだけ。
                        狭めた結果 見つからない局が出るほうが困る
                    -->
                    <div class="flex flex-wrap items-center gap-2">
                        <button
                            class="btn btn-primary"
                            disabled={scan.state === 'running'}
                            data-testid="scan-start"
                        >
                            {scan.state === 'running' ? '実行中…' : '開始する'}
                        </button>
                        {#if scan.state === 'running'}
                            <!--
                                十数分かかるので、途中で降りられるようにしてある。
                                中断しても設定は書き換えない (途中までの結果で上書きすると、
                                まだ回っていない局の定義が消える)
                            -->
                            <button
                                class="btn btn-error btn-outline"
                                formaction="?/scanStop"
                                data-testid="scan-stop"
                            >
                                中断する
                            </button>
                        {/if}
                    </div>
                </form>

                {#if scan.state !== 'idle'}
                    <div class="mt-4" data-testid="scan-progress" data-state={scan.state}>
                        <div class="flex flex-wrap items-center gap-2 text-sm">
                            <span class="badge" data-testid="scan-state">{STATE_LABEL[scan.state]}</span>
                            {#if scan.phase}
                                <span class="badge badge-ghost">{scan.phase}</span>
                            {/if}
                            <span data-testid="scan-found">見つかったチャンネル {scan.channels}</span>
                        </div>

                        <!-- 総当たりなので何分かかるか分かりにくい。どこまで進んだかを出す -->
                        <progress
                            class="progress progress-primary mt-2 w-full"
                            value={progress}
                            max="1"
                            data-testid="scan-bar"
                        ></progress>
                        <div class="text-base-content/60 mt-1 text-xs" data-testid="scan-count">
                            {scan.scanned} / {scan.total} チャンネル
                        </div>

                        {#if scan.error}
                            <div class="alert alert-error mt-2" data-testid="scan-failed">{scan.error}</div>
                        {/if}
                        {#if scan.log.length > 0}
                            <pre
                                class="bg-base-200 mt-2 max-h-64 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap"
                                data-testid="scan-log">{scan.log.join('\n')}</pre>
                        {/if}
                    </div>
                {/if}
            </div>
        </section>
    </div>

    <div class="flex min-w-0 flex-col gap-6">
        <!--
            **いちばん上に置く。** 録るのも番組表を集めるのもここの取り合いで、
            スキャン中に見たいのも「いま何本使っているか」。カードリーダーの
            具合も同じ機材の話なので、下に並べてある
        -->
        <section class="card bg-base-100 shadow" data-testid="tuner-card">
            <div class="card-body">
                <h2 class="card-title">チューナーの空き</h2>
                {#if shownTuners.value === undefined}
                    <p class="text-base-content/60 text-sm">確認中…</p>
                {:else}
                    {@const tuners = shownTuners.value.list}
                    {@const failure = shownTuners.value.error}
                    {#if failure !== null}
                        <!--
                            繋がらなかったときに空の一覧だけ出すと「1本も無い」と
                            見分けが付かない。理由をそのまま出す
                        -->
                        <div class="alert alert-error text-sm" data-testid="tuner-unreachable">
                            チューナーエージェントに繋がりません: {failure}
                        </div>
                    {:else if tuners.length === 0}
                        <p class="text-base-content/60 text-sm" data-testid="tuner-empty">
                            チューナーがありません。下の「チューナーの設定」から足してください。
                        </p>
                    {:else}
                        <div class="overflow-x-auto">
                            <table class="table table-sm">
                                <thead>
                                    <tr>
                                        <th>名前</th>
                                        <th>種別</th>
                                        <th>状態</th>
                                        <th class="w-full">使っているもの</th>
                                    </tr>
                                </thead>
                                <tbody data-testid="tuner-list">
                                    {#each tuners as tuner (tuner.index)}
                                        <tr data-testid="tuner-row" data-tuner-index={tuner.index}>
                                            <td class="whitespace-nowrap">{tuner.name}</td>
                                            <td class="whitespace-nowrap text-sm">
                                                {tuner.types.map((t) => TYPE_LABEL[t] ?? t).join('/')}
                                            </td>
                                            <td class="whitespace-nowrap">
                                                <!-- 何を掴んでいるかも出す。空き/使用中だけでは追えない -->
                                                {#if tuner.disabled}
                                                    <span class="badge badge-sm badge-ghost">無効</span>
                                                {:else if tuner.channel !== null}
                                                    <span class="badge badge-sm badge-warning">
                                                        {tuner.channel.channel}
                                                    </span>
                                                {:else}
                                                    <span class="badge badge-sm badge-success">空き</span>
                                                {/if}
                                                {#if tuner.error !== null && tuner.channel === null}
                                                    <div class="text-error text-xs" data-testid="tuner-error">
                                                        {tuner.error}
                                                    </div>
                                                {/if}
                                            </td>
                                            <td class="text-sm">
                                                <!--
                                                    **「優先度」とは呼ばない。**

                                                    ルール画面の「優先度」は*どの予約を残すか*で、
                                                    こちらは*いま掴んでいる1本を誰に譲るか*。
                                                    別の物差しなのに同じ名前で数字を並べていたので、
                                                    ルールの 2 が番組表の 3 に負けるように見えていた。
                                                    録画は必ず 10 で掴むので、そうはならない
                                                -->
                                                {#each tuner.users as user (user.use)}
                                                    <div class="truncate" data-testid="tuner-user">
                                                        {user.label}
                                                        <span class="text-base-content/60">
                                                            (掴む強さ {user.priority})
                                                        </span>
                                                    </div>
                                                {:else}
                                                    <span class="text-base-content/60">—</span>
                                                {/each}
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                    {/if}
                {/if}

                <!--
                    カードリーダー。**同じ機材の話**なのでここに置く。
                    掛かったまま録れてしまうのを避けるには、録る前に気づけること
                -->
                <div class="border-base-300 mt-2 flex flex-wrap items-center gap-2 border-t pt-3">
                    <span class="text-sm font-medium">カードリーダー</span>
                    {#if shownCard.value === undefined}
                        <span class="badge badge-ghost" data-testid="status-card-reader">確認中</span>
                    {:else}
                        {@const card = shownCard.value}
                        <span
                            class="badge {card.ok ? 'badge-success' : 'badge-error'}"
                            data-testid="status-card-reader"
                        >
                            {card.ok ? 'OK' : 'NG'}
                        </span>
                        <span class="text-base-content/60 w-full text-xs">{card.message}</span>
                        {#each card.readers as reader (reader)}
                            <span class="text-base-content/60 w-full font-mono text-xs break-all">
                                {reader}
                            </span>
                        {/each}
                    {/if}
                </div>
            </div>
        </section>

        <section class="card bg-base-100 shadow" data-testid="logo-card">
            <div class="card-body">
                <h2 class="card-title">ロゴ</h2>
                <dl class="space-y-3">
                    <!--
                        局ロゴ。放送波から拾うしかない。
                        番組表に出ないとき、取れていないのか出し方が悪いのかを
                        ここで見分けられるようにする
                    -->
                    <div class="flex flex-wrap items-center gap-2">
                        <dt class="w-28 text-sm font-medium">局ロゴ</dt>
                        <!-- 取れないぶんを除いて揃っていれば「揃った」でよい -->
                        <dd
                            class="badge {data.logos.have + data.logos.unavailable >= data.logos.total
                                ? 'badge-success'
                                : 'badge-ghost'}"
                            data-testid="status-logos"
                        >
                            {data.logos.have} / {data.logos.total} 局
                        </dd>
                        <!--
                            取りに行くものが無ければ口も出さない。押しても
                            「もう全部持っています」と断るだけになる。
                            **走っている最中でも押せる** — 押されたほうが譲る作りなので、
                            使えなくすると「BSを取っている間ずっと押せない」に逆戻りする
                        -->
                        {#if data.logos.pending > 0}
                            <dd>
                                <form method="POST" action="?/logoSweep" use:submitting>
                                    <button class="btn btn-xs" data-testid="logo-sweep">
                                        {data.logoSweep.running ? '取得中…' : '今すぐ取りに行く'}
                                    </button>
                                </form>
                            </dd>
                        {/if}
                        <dd class="text-base-content/60 w-full text-xs">
                            ロゴが放送波に流れてくるのは数十秒〜数分に一度、
                            <strong>衛星は十数分に一度</strong>です。普段は
                            <strong>番組表を集めるための選局に相乗りして</strong>拾うので、 denpa
                            がロゴのためにチューナーを増やすことはありません。一度取れたものも1週間経ったら取り直します。
                            「今すぐ取りに行く」を押したときは衛星も回ります。<strong
                                >BS も CS も同じ1つの中継から降ってくる</strong
                            >ので、そこだけ最大20分開きます (他の中継は数秒で見切ります)。
                            {#if data.logos.unavailable > 0}
                                <!--
                                    取れないものを「まだ取れていない」と出し続けると、
                                    こちらの不具合と見分けが付かない。

                                    **中継にロゴが無いことでは数えない。** CS の中継には
                                    ロゴが流れていないが、CS のロゴは BS の中継から
                                    降ってくる。中継で数えていた頃は、取れる CS の54局を
                                    まとめて「取れません」と出していた
                                -->
                                <br />
                                <strong>{data.logos.unavailable} 局</strong
                                >はロゴが放送に載っていないので取れません (1週間後にまた確かめます)。
                            {/if}
                        </dd>
                        <!--
                            1チャンネルに数分かかる。出さないと押しても何も起きていないように
                            見えるので、どこまで進んだかをそのまま流す
                        -->
                        {#if data.logoSweep.startedAt !== null}
                            <dd class="w-full space-y-1" data-testid="logo-sweep-progress">
                                <progress
                                    class="progress progress-primary w-full"
                                    value={data.logoSweep.done}
                                    max={Math.max(1, data.logoSweep.total)}
                                ></progress>
                                <div class="text-base-content/70 text-xs">
                                    <span data-testid="logo-sweep-count">
                                        {data.logoSweep.done} / {data.logoSweep.total} チャンネル
                                    </span>
                                    ・ 拾えた <strong>{data.logoSweep.found} 局</strong>
                                    {#if data.logoSweep.channels.length > 0}
                                        ・ 受信中 {data.logoSweep.channels.join(', ')}
                                    {/if}
                                </div>
                                {#if data.logoSweep.message !== ''}
                                    <div class="text-base-content/60 text-xs" data-testid="logo-sweep-done">
                                        {data.logoSweep.message}
                                    </div>
                                {/if}
                            </dd>
                        {/if}
                    </div>
                    <!--
                        CM検出のロゴ。**番組表に出す局ロゴとは別物** (logo-learn.ts)。
                        こちらは「画面のどこにロゴが出ているか」を logoframe に覚えさせたもの。

                        置き場所を録画の詳細からここへ移した。**録画ごとの話ではなく
                        局ごとの話**で、教えたら以降その局の全部に効く
                    -->
                    <div class="flex flex-wrap items-center gap-2">
                        <dt class="w-28 text-sm font-medium">CM検出のロゴ</dt>
                        <dd class="badge badge-ghost" data-testid="cm-logo-count">
                            {data.cmLogoStats.have} / {data.cmLogoStats.total} 局
                        </dd>
                        <dd class="text-base-content/60 w-full text-xs">
                            録画より先に、空いているチューナーで数分ぶん掴んで覚えます。覚えられなかった局は、
                            下から位置を教えてください (薄いロゴや動くロゴは自動では見つかりません)。
                        </dd>
                        {#if unlearned.length > 0}
                            <dd class="w-full space-y-2" data-testid="cm-logo-missing">
                                {#each unlearned as service (service.id)}
                                    <details class="rounded border-base-300 border p-2">
                                        <summary class="cursor-pointer text-sm">
                                            {service.name}
                                            {#if service.logo_area !== null}
                                                <span class="text-base-content/60 text-xs">
                                                    — 教えた範囲 {service.logo_area}
                                                </span>
                                            {/if}
                                        </summary>
                                        {#if service.recording_id === null}
                                            <p class="text-base-content/60 mt-2 text-xs">
                                                位置を教えるにはこの局の録画が1本要ります (コマを出すため)。
                                            </p>
                                        {:else}
                                            <LogoArea
                                                recordingId={service.recording_id}
                                                serviceId={service.id}
                                                serviceName={service.name}
                                                area={service.logo_area}
                                            />
                                        {/if}
                                    </details>
                                {/each}
                            </dd>
                        {/if}
                    </div>
                </dl>
            </div>
        </section>

        <!--
            チューナーの設定。**選局コマンドは出さない。**

            画面から自由な文字列を渡せるようにすると、denpa に入れた人が
            チューナー側で好きなコマンドを走らせられることになる (しかも
            あちらは privileged)。受け渡すのはデバイスと種別だけで、
            コマンドはエージェントが組み立てる。
        -->
        <section class="card bg-base-100 shadow" data-testid="tuner-config-card">
            <div class="card-body">
                <h2 class="card-title">チューナーの設定</h2>
                {#await data.detected then detected}
                    {#if detected}
                        <p class="text-base-content/60 text-sm" data-testid="tuner-detected">
                            いまは<strong>刺さっている機材を自動で見つけて</strong>使っています。
                            保存するとこの内容で固定されます。
                        </p>
                    {/if}
                {/await}

                {#if shownTuners.value !== undefined}
                    {@const rows = [...shownTuners.value.list, null]}
                    <form method="POST" action="?/tuners" use:submitting data-testid="tuner-config-form">
                        <div class="overflow-x-auto">
                            <table class="table table-sm">
                                <thead>
                                    <tr>
                                        <th>名前</th>
                                        <th>デバイス</th>
                                        <th>受けられる種別</th>
                                        <th>LNB</th>
                                        <th>無効</th>
                                    </tr>
                                </thead>
                                <tbody data-testid="tuner-config-list">
                                    {#each rows as tuner, index (index)}
                                        <tr data-testid="tuner-config-row">
                                            <td>
                                                <input
                                                    class="input input-sm input-bordered w-32"
                                                    name={`name.${index}`}
                                                    value={tuner?.name ?? ''}
                                                    placeholder={tuner === null ? '足す' : ''}
                                                />
                                            </td>
                                            <td>
                                                <input
                                                    class="input input-sm input-bordered w-72 font-mono text-xs"
                                                    name={`device.${index}`}
                                                    value={tuner?.device ?? ''}
                                                    placeholder="/dev/dvb/adapter0/frontend0"
                                                />
                                            </td>
                                            <td class="whitespace-nowrap">
                                                {#each TYPES as type (type)}
                                                    <label class="mr-2 inline-flex items-center gap-1">
                                                        <input
                                                            type="checkbox"
                                                            class="checkbox checkbox-xs"
                                                            name={`type.${index}.${type}`}
                                                            checked={tuner?.types.includes(type) ?? false}
                                                        />
                                                        <span class="text-xs">{TYPE_LABEL[type]}</span>
                                                    </label>
                                                {/each}
                                            </td>
                                            <td>
                                                <input
                                                    class="input input-sm input-bordered w-20"
                                                    name={`lnb.${index}`}
                                                    value={tuner?.lnb ?? ''}
                                                    placeholder="15v"
                                                />
                                            </td>
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    class="checkbox checkbox-sm"
                                                    name={`disabled.${index}`}
                                                    checked={tuner?.disabled ?? false}
                                                />
                                            </td>
                                        </tr>
                                        {#if tuner?.command}
                                            <tr>
                                                <td colspan="5" class="text-base-content/60 text-xs">
                                                    設定ファイルに直に書いた選局コマンドが効いています
                                                    (画面からは変えられません):
                                                    <code class="font-mono">{tuner.command}</code>
                                                </td>
                                            </tr>
                                        {/if}
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                        <p class="text-base-content/60 mt-2 text-xs">名前を空にすると、その行は消えます。</p>
                        <div class="card-actions mt-2">
                            <button class="btn btn-primary btn-sm" data-testid="tuner-config-save">
                                保存する
                            </button>
                            <button
                                class="btn btn-ghost btn-sm"
                                formaction="?/tunersAuto"
                                data-testid="tuner-config-auto"
                            >
                                自動検出に戻す
                            </button>
                        </div>
                    </form>
                {/if}
            </div>
        </section>
    </div>
</div>
