<script lang="ts">
    import { submitting } from '$lib/actions';
    import { liveUpdates } from '$lib/live-updates.svelte';

    let { data, form } = $props();

    // スキャンは数十分かかることがある。進み具合はサーバから push される。
    // 局の取り込みも1回では終わらないので、増えるたびに描き直す
    liveUpdates(['scan', 'services']);
    const scan = $derived(data.scan);

    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS' };
    const STATE_LABEL: Record<string, string> = {
        running: '実行中',
        done: '完了',
        failed: '失敗',
        canceled: '中断',
        idle: '待機中',
    };

    /** 進捗。総数が分かっているので割合で出せる */
    const progress = $derived(scan.total > 0 ? scan.scanned / scan.total : 0);

    /** denpa が取り込んだ局を物理チャンネルごとにまとめる */
    const byChannel = $derived.by(() => {
        const map = new Map<string, typeof data.services>();
        for (const service of data.services) {
            const key = `${service.type}:${service.channel}`;
            map.set(key, [...(map.get(key) ?? []), service]);
        }
        return map;
    });

    /*
     * チャンネル・局・番組表は別々に届く。1つの表に混ぜて出すので、
     * 揃うまで待ってから描く (バラバラに出ると列が入れ替わって見える)
     */
    const coverage = $derived(Promise.all([data.channels, data.mirakcServices, data.epg]));

    /**
     * 局名は取り込み済みのものがあればそちらを出す。
     * 放送波の局名は全角英数まじりなので、denpa は取り込むときに直している。
     * mirakc の生の名前をそのまま出すと、他の画面と字面が変わって別の局に見える
     */
    const importedById = $derived(new Map(data.services.map((s) => [s.id, s])));

    /** mirakc が拾えている局を物理チャンネルごとにまとめる */
    function groupByChannel<T extends { channel?: { type: string; channel: string } }>(
        services: T[],
    ): Map<string, T[]> {
        const map = new Map<string, T[]>();
        for (const service of services) {
            if (service.channel === undefined) continue;
            const key = `${service.channel.type}:${service.channel.channel}`;
            map.set(key, [...(map.get(key) ?? []), service]);
        }
        return map;
    }

    /** 番組表がどこまで埋まっているか。「8/9 まで」の形で出す */
    function until(at: number): string {
        const d = new Date(at);
        return `${d.getMonth() + 1}/${d.getDate()} まで`;
    }
</script>

<h1 class="mb-4 text-2xl font-bold">チューナー</h1>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="tuner-error">{form.message}</div>
{/if}
{#if form?.scan}
    <div class="alert alert-info mb-4" data-testid="tuner-notice">{form.scan}</div>
{/if}

<div class="grid items-start gap-6 xl:grid-cols-2">
    <div class="flex flex-col gap-6">
        <section class="card bg-base-100 shadow" data-testid="channel-card">
            <div class="card-body">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <h2 class="card-title">取れているチャンネル</h2>
                    <!--
                        mirakc が拾った局を denpa に取り込み直す。
                        普段は10分ごとに取り込んでいるので押す必要は無いが、
                        スキャンの直後だけは埋まるのを待たずに追いつきたい
                    -->
                    <form method="POST" action="?/resync" use:submitting>
                        <button
                            class="btn btn-sm"
                            disabled={data.settling || scan.state === 'running'}
                            data-testid="resync-services"
                        >
                            {data.settling ? '取り込み中…' : '局を取り直す'}
                        </button>
                    </form>
                </div>
                <p class="text-base-content/70 text-sm">
                    mirakc の設定に入っている物理チャンネルと、mirakc がそこから
                    今どこまで局と番組表を拾えているかです。<strong>スキャンの直後は空になり</strong
                    >、数十分かけて埋まっていきます。スキャンが終わったあとは、増えなくなるまで denpa
                    が自動で取り込み続けます。
                </p>
                {#await coverage}
                    <p class="text-base-content/60 text-sm">確認中…</p>
                {:then [channels, mirakcServices, epg]}
                    {#if channels.length === 0}
                        <p class="text-base-content/60 text-sm" data-testid="channel-empty">
                            まだ1つもありません。チャンネルスキャンを実行してください。
                        </p>
                    {:else}
                        {@const epgByService = new Map(epg.map((e) => [e.key, e]))}
                        {@const servicesByChannel = groupByChannel(mirakcServices)}
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
                                    {#each channels as channel (`${channel.type}:${channel.channel}`)}
                                        {@const key = `${channel.type}:${channel.channel}`}
                                        {@const found = servicesByChannel.get(key) ?? []}
                                        {@const imported = byChannel.get(key) ?? []}
                                        {@const stats = found.map(
                                            (s) =>
                                                epgByService.get(`${s.networkId}:${s.serviceId}`) ?? {
                                                    programs: 0,
                                                    until: 0,
                                                },
                                        )}
                                        {@const programs = stats.reduce((sum, s) => sum + s.programs, 0)}
                                        {@const last = Math.max(0, ...stats.map((s) => s.until))}
                                        <tr data-testid="channel-row" data-channel={channel.channel}>
                                            <td class="whitespace-nowrap text-sm">
                                                {TYPE_LABEL[channel.type] ?? channel.type}
                                            </td>
                                            <td class="font-mono text-sm whitespace-nowrap">
                                                {channel.channel}
                                            </td>
                                            <td class="text-sm">
                                                {#if found.length > 0}
                                                    <div data-testid="channel-services">
                                                        {found
                                                            .map(
                                                                (s) => importedById.get(s.id)?.name ?? s.name,
                                                            )
                                                            .join(', ')}
                                                    </div>
                                                    <!--
                                                        denpa 側の取り込みは10分ごとなので、
                                                        mirakc が見つけた直後は必ず差が出る。
                                                        隠すと「取り込まれない」と区別が付かない
                                                    -->
                                                    {#if imported.length < found.length}
                                                        <div
                                                            class="text-base-content/60 text-xs"
                                                            data-testid="channel-pending"
                                                        >
                                                            denpa への取り込み待ち ({imported.length}/{found.length})
                                                        </div>
                                                    {/if}
                                                {:else}
                                                    <span class="text-base-content/60">
                                                        mirakc がまだ局を拾えていません
                                                    </span>
                                                {/if}
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
                {/await}
            </div>
        </section>

        <section class="card bg-base-100 shadow" data-testid="scan-card">
            <div class="card-body">
                <h2 class="card-title">チャンネルスキャン</h2>
                <p class="text-base-content/70 text-sm">
                    受信できるチャンネルを実際に選局して探します。<strong
                        >その間チューナーを全部使い、mirakc も止まります</strong
                    >ので、録画の予定が無いときに実行してください。 見つかったものは mirakc
                    の設定に書き戻し、終わると番組表も取り直します。
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

    <div class="flex flex-col gap-6">
        <section class="card bg-base-100 shadow" data-testid="status-card">
            <div class="card-body">
                <h2 class="card-title">つながり具合</h2>
                <dl class="space-y-3">
                    <div class="flex flex-wrap items-center gap-2">
                        <dt class="w-28 text-sm font-medium">mirakc</dt>
                        {#await data.mirakc}
                            <dd class="badge badge-ghost" data-testid="status-mirakc">確認中</dd>
                        {:then mirakc}
                            <dd
                                class="badge {mirakc.ok ? 'badge-success' : 'badge-error'}"
                                data-testid="status-mirakc"
                            >
                                {mirakc.ok ? (mirakc.version ?? 'OK') : 'NG'}
                            </dd>
                            {#if !mirakc.ok}
                                <!-- スキャン中は止めてあるので、繋がらないのが正しい -->
                                <dd class="text-base-content/60 w-full text-xs">
                                    {scan.state === 'running' ? 'スキャン中のため止めています' : mirakc.error}
                                </dd>
                            {/if}
                        {/await}
                    </div>
                    <!--
                        局ロゴ。mirakc は集めないので denpa が放送波から拾っている。
                        番組表に出ないとき、取れていないのか出し方が悪いのかを
                        ここで見分けられるようにする
                    -->
                    <div class="flex flex-wrap items-center gap-2">
                        <dt class="w-28 text-sm font-medium">局ロゴ</dt>
                        <dd
                            class="badge {data.logos.have === data.logos.total
                                ? 'badge-success'
                                : 'badge-ghost'}"
                            data-testid="status-logos"
                        >
                            {data.logos.have} / {data.logos.total} 局
                        </dd>
                        <dd>
                            <form method="POST" action="?/logoSweep" use:submitting>
                                <button class="btn btn-xs" data-testid="logo-sweep">いま取りに行く</button>
                            </form>
                        </dd>
                        <dd class="text-base-content/60 w-full text-xs">
                            ロゴが放送波に流れてくるのは数十秒〜数分に一度です。10分ごとに少しずつ拾っているので、
                            全部揃うまでには時間がかかります。
                        </dd>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                        <dt class="w-28 text-sm font-medium">カードリーダー</dt>
                        {#await data.card}
                            <dd class="badge badge-ghost" data-testid="status-card-reader">確認中</dd>
                        {:then card}
                            <dd
                                class="badge {card.ok ? 'badge-success' : 'badge-error'}"
                                data-testid="status-card-reader"
                            >
                                {card.ok ? 'OK' : 'NG'}
                            </dd>
                            <dd class="text-base-content/60 w-full text-xs">{card.message}</dd>
                            {#each card.readers as reader (reader)}
                                <dd class="text-base-content/60 w-full font-mono text-xs break-all">
                                    {reader}
                                </dd>
                            {/each}
                        {/await}
                    </div>
                </dl>
            </div>
        </section>

        <section class="card bg-base-100 shadow" data-testid="tuner-card">
            <div class="card-body">
                <h2 class="card-title">チューナーの空き</h2>
                {#await data.tuners}
                    <p class="text-base-content/60 text-sm">確認中…</p>
                {:then tuners}
                    {#if tuners.length === 0}
                        <p class="text-base-content/60 text-sm" data-testid="tuner-empty">
                            チューナーが取れません。{scan.state === 'running'
                                ? 'スキャン中は mirakc を止めています。'
                                : 'mirakc の設定を確認してください。'}
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
                                                <!-- 故障は空き/使用中より先に出す。直さないと録れない -->
                                                {#if tuner.isFault}
                                                    <span class="badge badge-sm badge-error">故障</span>
                                                {:else if tuner.isUsing}
                                                    <span class="badge badge-sm badge-warning">使用中</span>
                                                {:else if tuner.isAvailable}
                                                    <span class="badge badge-sm badge-success">空き</span>
                                                {:else}
                                                    <span class="badge badge-sm badge-ghost">使えません</span>
                                                {/if}
                                            </td>
                                            <td class="text-sm">
                                                {#each tuner.users ?? [] as user (user.id)}
                                                    <div class="truncate">
                                                        {user.agent ?? user.id}
                                                        <span class="text-base-content/60">
                                                            (優先度 {user.priority})
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
                {/await}
            </div>
        </section>
    </div>
</div>
