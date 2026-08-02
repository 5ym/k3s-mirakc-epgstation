<script lang="ts">
    import { submitting } from '$lib/actions';

    /**
     * 局ロゴの位置を教える。
     *
     * CM検出を jls にしていると、logoframe が自分でロゴを覚える。ただし
     * 「画面の隅にずっと同じ縁がある」ことを手がかりに探すので、薄いロゴや
     * 動くロゴだと見つけられない。そういう局だけ、ここで囲ってもらう。
     *
     * 渡すのは**放送そのままの座標**。切り出したコマは幅960に縮めてあるので、
     * 送るときに元の大きさへ戻す。
     */
    let {
        recordingId,
        serviceId,
        serviceName,
        area = null,
    }: {
        recordingId: number;
        serviceId: number;
        serviceName: string;
        /** 既に入れてある範囲 ("x,y,w,h")。やり直すとき用 */
        area?: string | null;
    } = $props();

    /** どのコマを見るか。ロゴが出ている場面まで送れるようにする */
    let at = $state(300);
    let image = $state<HTMLImageElement | null>(null);
    /** 読み込みに失敗したコマ。位置を変えてもらう */
    let failed = $state(false);

    /** 表示上の矩形 (画像の中の座標) */
    let box = $state<{ x: number; y: number; w: number; h: number } | null>(null);
    let dragFrom: { x: number; y: number } | null = null;

    const src = $derived(`/api/recordings/${recordingId}/frame?at=${at}`);

    /** 表示は縮めてあるので、送るときは元の大きさに戻す */
    const scale = $derived(
        image === null || image.clientWidth === 0 ? 1 : image.naturalWidth / image.clientWidth,
    );

    const value = $derived(
        box === null
            ? ''
            : [
                  Math.round(box.x * scale),
                  Math.round(box.y * scale),
                  Math.round(box.w * scale),
                  Math.round(box.h * scale),
              ].join(','),
    );

    function at_(event: PointerEvent): { x: number; y: number } {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function down(event: PointerEvent): void {
        if (event.button !== 0) return;
        dragFrom = at_(event);
        box = { ...dragFrom, w: 0, h: 0 };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function move(event: PointerEvent): void {
        if (dragFrom === null) return;
        const now = at_(event);
        // どちらへ引いても同じ矩形になるようにする
        box = {
            x: Math.min(dragFrom.x, now.x),
            y: Math.min(dragFrom.y, now.y),
            w: Math.abs(now.x - dragFrom.x),
            h: Math.abs(now.y - dragFrom.y),
        };
    }

    function up(): void {
        dragFrom = null;
        // 押しただけ (掴み損ね) は選択とみなさない
        if (box !== null && (box.w < 8 || box.h < 8)) box = null;
    }
</script>

<div class="mt-3" data-testid="logo-area">
    <div class="text-sm font-medium">ロゴの位置を教える</div>
    <p class="text-base-content/70 mt-1 text-sm">
        {serviceName} のロゴを自動で見つけられませんでした。ロゴが出ているコマまで送って、
        <strong>ロゴを四角で囲って</strong>ください。次のエンコードから使います。
    </p>

    <div class="mt-2 flex flex-wrap items-end gap-2">
        <label class="flex flex-col gap-1">
            <span class="text-xs font-medium">見る位置 (秒)</span>
            <input
                type="number"
                min="0"
                step="30"
                bind:value={at}
                class="input input-bordered input-sm w-28"
                data-testid="logo-at"
            />
        </label>
        <span class="text-base-content/60 text-xs">ロゴが出ていない場面なら位置を変えてください</span>
    </div>

    <!--
        画像の上で掴んで引く。canvas は使わない (画像に重ねた div で足りるうえ、
        拡大縮小の計算が1箇所で済む)
    -->
    <div
        class="bg-base-200 relative mt-2 inline-block max-w-full touch-none select-none"
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        role="presentation"
    >
        <img
            {src}
            alt="ロゴの位置を選ぶためのコマ"
            class="block max-w-full"
            bind:this={image}
            onerror={() => (failed = true)}
            onload={() => (failed = false)}
            data-testid="logo-frame"
        />
        {#if box !== null}
            <div
                class="border-primary bg-primary/20 pointer-events-none absolute border-2"
                style="left:{box.x}px; top:{box.y}px; width:{box.w}px; height:{box.h}px;"
            ></div>
        {/if}
    </div>

    {#if failed}
        <div class="text-error mt-1 text-sm" data-testid="logo-frame-error">
            そのコマを取り出せませんでした。位置を変えてみてください。
        </div>
    {/if}

    <form method="POST" action="?/logoArea" use:submitting class="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="serviceId" value={serviceId} />
        <input type="hidden" name="area" {value} />
        <button class="btn btn-sm btn-primary" disabled={value === ''} data-testid="logo-save">
            この位置で覚える
        </button>
        <span class="text-base-content/60 font-mono text-xs" data-testid="logo-value">
            {value || (area ? `いまの設定: ${area}` : '囲ってください')}
        </span>
        {#if area}
            <button
                class="btn btn-sm btn-ghost"
                formaction="?/logoAreaClear"
                data-testid="logo-clear"
                type="submit"
            >
                自動に戻す
            </button>
        {/if}
    </form>
</div>
