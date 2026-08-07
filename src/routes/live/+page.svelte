<script lang="ts">
    import { onMount } from 'svelte';
    import { lastChannel, livePlayer } from '$lib/live-player.svelte';
    import { time } from '$lib/format';
    import type { LiveChannel } from './+page.server';

    let { data } = $props();
    // 局が入れ替わると読み込み直されるので、値ではなく参照で持つ
    const channels = $derived(data.channels as LiveChannel[]);

    const player = livePlayer();
    let video: HTMLVideoElement;

    /**
     * **前回見ていたチャンネルで開く。** 覚えていない (初めて開いた) ときは
     * 一覧の先頭 = リモコン番号のいちばん若い局。テレビを点けたときと同じ振る舞い。
     *
     * 局が入れ替わって前回のものが消えていることがあるので、居るかどうかは見る。
     */
    onMount(() => {
        const saved = lastChannel();
        const found =
            saved === null
                ? undefined
                : channels.find((c) => c.type === saved.channelType && c.channel === saved.channel);
        const target = found ?? channels[0];
        if (target !== undefined) {
            void player.tune(video, {
                channelType: target.type,
                channel: target.channel,
                serviceId: target.id,
            });
        }
        return () => player.stop();
    });

    /** いま映している局。一覧で目立たせる */
    const current = $derived(
        channels.find((c) => c.type === player.tuned?.channelType && c.channel === player.tuned?.channel),
    );

    /*
     * **一覧は種別で切り替える。** 地上波・BS・CS を全部縦に並べると、CS の局が
     * 100を超える環境では地上波が上のほうへ流れて見えなくなる。番組表と
     * 同じ並び・同じ見た目にしてあるので、探す場所がずれない
     */
    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS' };
    /** 局を持っている種別だけ出す。BS を繋いでいない環境で空の見出しを出さない */
    const types = $derived(['GR', 'BS', 'CS'].filter((t) => channels.some((c) => c.type === t)));
    /** **開いたときは、いま映している局の種別。** 選び直す手間を増やさない */
    let picked = $state<string | null>(null);
    const shown = $derived(picked ?? current?.type ?? types[0] ?? 'GR');
    const listed = $derived(channels.filter((c) => c.type === shown));

    function select(channel: LiveChannel): void {
        void player.tune(video, {
            channelType: channel.type,
            channel: channel.channel,
            serviceId: channel.id,
        });
    }

    /**
     * 一覧の各行。**開いたときに、いま映しているものまで送るのに要る。**
     *
     * 局が100を超える環境では、覚えていた局が画面の外にあることのほうが普通。
     * 探させるのは、テレビを点けたときの振る舞いから遠い
     */
    const rows: Record<number, HTMLElement | undefined> = $state({});
    /** 一度送ったら、あとは触らない。見ている途中で勝手に動くと邪魔になる */
    let scrolled = false;
    $effect(() => {
        const row = current === undefined ? undefined : rows[current.id];
        if (scrolled || row === undefined) return;
        scrolled = true;
        row.scrollIntoView({ block: 'center' });
    });

    /** 全画面。映像だけでなく操作列も一緒に大きくしたいので、箱ごと入れる */
    function full(): void {
        const box = video?.parentElement;
        if (box === null || box === undefined) return;
        if (document.fullscreenElement === null) void box.requestFullscreen().catch(() => {});
        else void document.exitFullscreen().catch(() => {});
    }
</script>

<!--
    **映像を左、局を右。** 動画を見ながら次を選べる並びで、YouTube の再生画面と
    同じ形。畳まれる幅では縦に積む (横に並べると映像が切手大になる)。

    **広い画面ではページごとスクロールさせない** (`+layout.svelte` の `fill`)。
    映像を見ながら選ぶものなので、ページが動くと絵が画面から出ていく。
    動くのは右の一覧だけ。`min-h-0` が要る — 付けないと flex の子は中身の高さで
    突っ張って、外側の `overflow` が効かない
-->
<div class="flex flex-col gap-4 lg:h-full lg:min-h-0 lg:flex-row" data-testid="live">
    <div class="flex min-w-0 flex-1 flex-col lg:min-h-0">
        <!-- 映像は高さのほうを上限にする。横幅いっぱいにすると縦がはみ出す -->
        <div class="bg-base-300 relative aspect-video max-h-full overflow-hidden rounded-lg">
            <!-- svelte-ignore a11y_media_has_caption -->
            <!-- 字幕は第2段階。放送の字幕は canvas に重ねる (docs/stream.md §5.2) -->
            <!--
                **`autoplay` と `muted` は付けない。** 鳴らし始めるのは
                `live-player` の役目で、音ありで断られたときだけ自分で黙る。
                ここで `muted` にすると、断られていないときまで無音になる
            -->
            <!--
                **備え付けの操作は出さない** (`controls` を付けない)。あれの
                再生位置は「持っている範囲」を尺として描くので、0.05秒ごとに
                中身が届くたびに右へ左へ動く。放送に終わりは無いのだから、
                位置ではなく**張り付いているかどうか**を出すのが正しい
            -->
            <video bind:this={video} class="h-full w-full bg-black" playsinline data-testid="live-video"
            ></video>

            {#if player.tuned !== null && player.state !== 'error'}
                <!--
                    自前の操作列。**放送の今に居るときは右端に張り付く。**
                    止めても受け取りは続くので、止めた所から見られる。

                    絵が出る前から出しておく — 出たり消えたりすると、押そうとした
                    ところで動くことになる
                -->
                <div
                    class="absolute right-0 bottom-0 left-0 flex items-center gap-3
                           bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-3"
                    data-testid="live-controls"
                >
                    <button
                        class="btn btn-circle btn-sm btn-ghost text-white"
                        onclick={() => player.toggle()}
                        aria-label={player.paused ? '再生' : '一時停止'}
                        data-testid="live-play"
                    >
                        {player.paused ? '▶' : '❚❚'}
                    </button>

                    <!--
                        戻れる範囲の中のどこに居るか。**放送の今に居れば右端。**
                        押すとその時刻へ移る
                    -->
                    <input
                        type="range"
                        class="range range-xs flex-1"
                        min={player.oldest}
                        max={player.newest}
                        step="0.1"
                        value={player.position}
                        oninput={(event) => player.seek(Number(event.currentTarget.value))}
                        aria-label="再生位置"
                        data-testid="live-seek"
                    />

                    <!-- 放送の今に居るかどうか。離れていれば押して戻れる -->
                    <button
                        class="btn btn-xs gap-1 {player.live ? 'btn-error' : 'btn-ghost text-white'}"
                        onclick={() => player.goLive()}
                        data-testid="live-edge"
                    >
                        <span class="inline-block size-2 rounded-full {player.live ? 'bg-white' : 'bg-error'}"
                        ></span>
                        ライブ
                    </button>

                    <button
                        class="btn btn-circle btn-sm btn-ghost text-white"
                        onclick={() => (player.silenced ? player.unmute() : player.mute())}
                        aria-label={player.silenced ? '音を出す' : '音を消す'}
                        data-testid="live-sound"
                    >
                        {player.silenced ? '🔇' : '🔊'}
                    </button>

                    <button
                        class="btn btn-circle btn-sm btn-ghost text-white"
                        onclick={() => full()}
                        aria-label="全画面"
                        data-testid="live-full"
                    >
                        ⛶
                    </button>
                </div>
            {/if}

            {#if player.silenced && player.state === 'playing'}
                <!--
                    **押されるまで音は出せない。** 前回のチャンネルで勝手に
                    始める作りなので、開いた直後は「押した」ことになっておらず、
                    ブラウザが音ありの再生を断る。押せる場所を出す
                -->
                <button
                    class="btn btn-sm btn-neutral absolute top-3 left-3 gap-2"
                    onclick={() => player.unmute()}
                    data-testid="live-unmute"
                >
                    音を出す
                </button>
            {/if}

            {#if player.state !== 'playing'}
                <!--
                    何も出ていない間に何が起きているかを出す。黒いままだと壊れて見える。

                    **押せる邪魔をしない** (`pointer-events-none`)。箱いっぱいに
                    広がるので、そのままだと下の操作列を覆って押せなくなる。
                    中の「やり直す」だけは押せるように戻す
                -->
                <div
                    class="bg-base-300/80 pointer-events-none absolute inset-0 flex items-center
                           justify-center"
                    data-testid="live-status"
                >
                    {#if player.state === 'connecting'}
                        <span class="loading loading-spinner loading-lg"></span>
                    {:else if player.state === 'error'}
                        <div class="text-center">
                            <div class="text-error font-medium">{player.message}</div>
                            <button
                                class="btn pointer-events-auto btn-sm mt-3"
                                onclick={() => current && select(current)}
                                data-testid="live-retry">やり直す</button
                            >
                        </div>
                    {:else}
                        <span class="text-base-content/60">選んでください</span>
                    {/if}
                </div>
            {/if}
        </div>

        {#if current}
            <div class="mt-3">
                <h1 class="text-lg font-bold" data-testid="live-title">
                    {current.now?.name ?? current.name}
                </h1>
                <p class="text-base-content/60 mt-1 text-sm">
                    {current.name}
                    {#if current.now}
                        ・ {time(current.now.startAt)} 〜 {time(current.now.endAt)}
                    {/if}
                    <!--
                        **放送からどれだけ遅れているか。** 詰めていく作業をするのに、
                        見えないと当てずっぽうになる
                    -->
                    {#if player.delay !== null}
                        ・ <span data-testid="live-delay">遅延 {player.delay.toFixed(1)}秒</span>
                    {/if}
                </p>
            </div>
        {/if}
    </div>

    <!--
        **右の列。** 幅は固定にして、映像側だけ伸ばす。番組表と同じ並び
        (リモコン番号順、持たない局は物理チャンネル順) にしてあるので、
        番組表で見つけた局をここでも同じ位置で探せる。

        **高さは残りぜんぶ。** `max-h-[70vh]` で切っていた頃は、画面の下に
        余白があるのに一覧のほうが先に終わっていた
    -->
    <aside class="flex flex-col lg:min-h-0 lg:w-80 lg:shrink-0">
        <!-- 番組表と同じ並び・同じ見た目。探す場所がずれないようにする -->
        <div class="join mb-2" data-testid="live-type-tabs">
            {#each types as type (type)}
                <button
                    class="btn join-item btn-sm {shown === type ? 'btn-active' : ''}"
                    onclick={() => (picked = type)}
                    data-testid="live-type-{type}"
                >
                    {TYPE_LABEL[type]}
                </button>
            {/each}
        </div>
        <!--
            **押せると分かる形にする。** 平らに並べていた頃は、文字が並んでいる
            だけに見えて押せると気付けなかった。枠を持たせ、指を乗せると浮かせ、
            いま映しているものは色で塗る
        -->
        <ul class="flex-1 space-y-1 overflow-y-auto lg:min-h-0" data-testid="live-channels">
            {#each listed as channel (channel.id)}
                <li>
                    <button
                        bind:this={rows[channel.id]}
                        class="flex w-full cursor-pointer items-center gap-3 rounded-lg border p-2 text-left
                               transition-colors
                               {current?.id === channel.id
                            ? 'border-primary bg-primary/15 ring-primary/40 ring-1'
                            : 'border-base-300 hover:border-base-content/30 hover:bg-base-200'}"
                        onclick={() => select(channel)}
                        aria-current={current?.id === channel.id ? 'true' : undefined}
                        data-testid="live-channel"
                        data-current={current?.id === channel.id ? 'true' : 'false'}
                        data-channel="{channel.type}/{channel.channel}"
                    >
                        {#if channel.hasLogo}
                            <img
                                src="/api/services/{channel.id}/logo"
                                alt=""
                                class="size-8 shrink-0 rounded object-contain"
                            />
                        {:else}
                            <span
                                class="bg-base-300 flex size-8 shrink-0 items-center justify-center rounded text-xs"
                            >
                                {channel.remoteControlKey ?? channel.type}
                            </span>
                        {/if}
                        <span class="min-w-0 flex-1">
                            <span
                                class="block truncate text-sm font-medium
                                       {current?.id === channel.id ? 'text-primary' : ''}"
                            >
                                {channel.name}
                            </span>
                            {#if channel.now}
                                <span class="text-base-content/60 block truncate text-xs">
                                    {channel.now.name}
                                </span>
                            {/if}
                        </span>
                        <!-- いま映しているもの。色だけだと、色の見え方が違う人に伝わらない -->
                        {#if current?.id === channel.id}
                            <span class="badge badge-primary badge-sm shrink-0">視聴中</span>
                        {/if}
                    </button>
                </li>
            {/each}
        </ul>
    </aside>
</div>
