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
    let fullscreened = $state(false);
    function full(): void {
        const box = video?.parentElement;
        if (box === null || box === undefined) return;
        if (document.fullscreenElement === null) void box.requestFullscreen().catch(() => {});
        else void document.exitFullscreen().catch(() => {});
    }
    $effect(() => {
        const update = () => (fullscreened = document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', update);
        return () => document.removeEventListener('fullscreenchange', update);
    });

    /**
     * 操作列を出しておく時間 (ms)。**絵の上に居座るものなので、触っていない間は
     * 引っ込める。** 止めている間と、キーボードで触っている間は残す
     */
    const LINGER = 2500;
    let touched = $state(Date.now());
    let keyboard = $state(false);
    let now = $state(Date.now());
    /*
     * **見るのは「触ったか」と「止めているか」だけ。** 再生できているかどうかを
     * 混ぜていた頃は、繋いでいる間ずっと出たままになり、消える経路を
     * 確かめようが無かった。繋いでいる間も、動かせばすぐ戻る
     */
    const controlsShown = $derived(player.paused || keyboard || now - touched < LINGER);
    /** 消す時刻を跨ぐためだけの目覚まし。出ている間しか回さない */
    $effect(() => {
        if (controlsShown === false) return;
        const timer = setInterval(() => (now = Date.now()), 250);
        return () => clearInterval(timer);
    });
    const wake = () => {
        touched = Date.now();
        now = touched;
    };

    /**
     * **アイコンは既存の画面と同じ書き方に揃える** (インラインの SVG)。
     * 絵文字にしていた頃は、端末ごとに形も大きさも変わっていた
     */
    const PLAY = 'M8 5v14l11-7z';
    const PAUSE = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
    const SOUND_ON =
        'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
    const SOUND_OFF =
        'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';
    const EXPAND = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
    const SHRINK = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';
</script>

{#snippet icon(path: string)}
    <svg viewBox="0 0 24 24" class="size-5" fill="currentColor" aria-hidden="true">
        <path d={path} />
    </svg>
{/snippet}

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
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="bg-base-300 relative aspect-video max-h-full overflow-hidden rounded-lg
                   {controlsShown ? '' : 'cursor-none'}"
            onpointermove={wake}
            onpointerdown={wake}
            onpointerleave={() => (touched = 0)}
            onfocusin={() => (keyboard = true)}
            onfocusout={() => (keyboard = false)}
        >
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
                <!--
                    **しばらく触らなければ消える。** 絵の上に居座るものなので、
                    見ている間は引っ込んでいるほうがいい。止めている間と、
                    キーボードで触っている間は残す
                -->
                <div
                    class="absolute right-0 bottom-0 left-0 flex items-center gap-2
                           bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-3 text-white
                           transition-opacity duration-200
                           {controlsShown ? 'opacity-100' : 'pointer-events-none opacity-0'}"
                    data-testid="live-controls"
                    data-shown={controlsShown}
                >
                    <button
                        class="btn btn-circle btn-sm btn-ghost hover:bg-white/20"
                        onclick={() => player.toggle()}
                        aria-label={player.paused ? '再生' : '一時停止'}
                        data-testid="live-play"
                    >
                        {@render icon(player.paused ? PLAY : PAUSE)}
                    </button>

                    <button
                        class="btn btn-circle btn-sm btn-ghost hover:bg-white/20"
                        onclick={() => (player.silenced ? player.unmute() : player.mute())}
                        aria-label={player.silenced ? '音を出す' : '音を消す'}
                        data-testid="live-sound"
                    >
                        {@render icon(player.silenced ? SOUND_OFF : SOUND_ON)}
                    </button>

                    <!--
                        戻れる範囲の中のどこに居るか。押すとその時刻へ移る。

                        **放送の今に居る間は右端に張り付かせる。** 実際には
                        貯めているぶん (0.5秒ほど) 後ろに居るが、そこを描くと
                        溜まりが増えるたびに摘みが左へ動く — 見ている人には
                        「勝手に戻っている」としか映らない
                    -->
                    <input
                        type="range"
                        class="range range-xs range-error mx-1 flex-1"
                        min={player.oldest}
                        max={player.newest}
                        step="0.1"
                        value={player.live ? player.newest : player.position}
                        oninput={(event) => player.seek(Number(event.currentTarget.value))}
                        aria-label="再生位置"
                        data-testid="live-seek"
                    />

                    <!-- 放送の今に居るかどうか。離れていれば押して戻れる -->
                    <button
                        class="btn btn-sm gap-1.5 {player.live ? 'btn-error' : 'btn-ghost hover:bg-white/20'}"
                        onclick={() => player.goLive()}
                        data-testid="live-edge"
                    >
                        <span
                            class="inline-block size-2 rounded-full {player.live
                                ? 'bg-error-content'
                                : 'bg-error'}"
                        ></span>
                        ライブ
                    </button>

                    <button
                        class="btn btn-circle btn-sm btn-ghost hover:bg-white/20"
                        onclick={() => full()}
                        aria-label={fullscreened ? '全画面をやめる' : '全画面'}
                        data-testid="live-full"
                    >
                        {@render icon(fullscreened ? SHRINK : EXPAND)}
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
