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
            void player.tune(video, { channelType: target.type, channel: target.channel });
        }
        return () => player.stop();
    });

    /** いま映している局。一覧で目立たせる */
    const current = $derived(
        channels.find((c) => c.type === player.tuned?.channelType && c.channel === player.tuned?.channel),
    );

    function select(channel: LiveChannel): void {
        void player.tune(video, { channelType: channel.type, channel: channel.channel });
    }
</script>

<!--
    **映像を左、局を右。** 動画を見ながら次を選べる並びで、YouTube の再生画面と
    同じ形。畳まれる幅では縦に積む (横に並べると映像が切手大になる)
-->
<div class="flex flex-col gap-4 lg:flex-row" data-testid="live">
    <div class="min-w-0 flex-1">
        <div class="bg-base-300 relative aspect-video overflow-hidden rounded-lg">
            <!-- svelte-ignore a11y_media_has_caption -->
            <!-- 字幕は第2段階。放送の字幕は canvas に重ねる (docs/stream.md §5.2) -->
            <video
                bind:this={video}
                class="h-full w-full bg-black"
                autoplay
                muted
                playsinline
                controls
                data-testid="live-video"
            ></video>

            {#if player.state !== 'playing'}
                <!-- 何も出ていない間に何が起きているかを出す。黒いままだと壊れて見える -->
                <div
                    class="bg-base-300/80 absolute inset-0 flex items-center justify-center"
                    data-testid="live-status"
                >
                    {#if player.state === 'connecting'}
                        <span class="loading loading-spinner loading-lg"></span>
                    {:else if player.state === 'error'}
                        <div class="text-center">
                            <div class="text-error font-medium">{player.message}</div>
                            <button
                                class="btn btn-sm mt-3"
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
                </p>
            </div>
        {/if}
    </div>

    <!--
        **右の列。** 幅は固定にして、映像側だけ伸ばす。番組表と同じ並び
        (リモコン番号順、持たない局は物理チャンネル順) にしてあるので、
        番組表で見つけた局をここでも同じ位置で探せる
    -->
    <aside class="lg:w-80 lg:shrink-0">
        <h2 class="mb-2 text-sm font-medium">チャンネル</h2>
        <ul class="max-h-[70vh] space-y-1 overflow-y-auto" data-testid="live-channels">
            {#each channels as channel (channel.id)}
                <li>
                    <button
                        class="hover:bg-base-200 flex w-full items-center gap-3 rounded p-2 text-left
                               {current?.id === channel.id ? 'bg-base-200' : ''}"
                        onclick={() => select(channel)}
                        data-testid="live-channel"
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
                            <span class="block truncate text-sm font-medium">{channel.name}</span>
                            {#if channel.now}
                                <span class="text-base-content/60 block truncate text-xs">
                                    {channel.now.name}
                                </span>
                            {/if}
                        </span>
                    </button>
                </li>
            {/each}
        </ul>
    </aside>
</div>
