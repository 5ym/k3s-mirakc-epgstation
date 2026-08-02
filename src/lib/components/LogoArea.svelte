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

    /**
     * コマを取り出して出す。
     *
     * `<img src>` で直に読まず fetch を通すのは、**記録されているコマの大きさ**を
     * 応答の見出し (X-Source-Width/Height) から受け取るため。地上波のHDは
     * 1440×1080 に記録されていて画素が正方形ではないので、放送どおりの
     * 縦横比で出した絵の大きさからは元の大きさを逆算できない。
     * logoframe が見るのは記録されているほうなので、送るときはそこへ戻す。
     */
    let frame = $state<{ url: string; width: number; height: number } | null>(null);
    $effect(() => {
        const position = at;
        const controller = new AbortController();
        let url: string | null = null;
        void (async () => {
            try {
                const res = await fetch(`/api/recordings/${recordingId}/frame?at=${position}`, {
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error(String(res.status));
                const blob = await res.blob();
                url = URL.createObjectURL(blob);
                frame = {
                    url,
                    width: Number(res.headers.get('X-Source-Width')) || 0,
                    height: Number(res.headers.get('X-Source-Height')) || 0,
                };
                failed = false;
            } catch {
                if (controller.signal.aborted) return;
                frame = null;
                failed = true;
            }
        })();
        return () => {
            controller.abort();
            if (url !== null) URL.revokeObjectURL(url);
        };
    });

    /** 囲ってもらった矩形を、記録されているコマの座標に直す */
    const value = $derived.by(() => {
        if (box === null || image === null || frame === null) return '';
        if (image.clientWidth === 0 || image.clientHeight === 0) return '';
        // 縦横比を直してあるので、横と縦で伸び方が違う。別々に戻す
        const x = frame.width / image.clientWidth;
        const y = frame.height / image.clientHeight;
        return [
            Math.round(box.x * x),
            Math.round(box.y * y),
            Math.round(box.w * x),
            Math.round(box.h * y),
        ].join(',');
    });

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
        {#if frame !== null}
            <img
                src={frame.url}
                alt="ロゴの位置を選ぶためのコマ"
                class="block max-w-full"
                bind:this={image}
                data-testid="logo-frame"
            />
        {:else}
            <!-- 取り出している間も掴む場所を残しておく。出た瞬間に大きさが変わらないように -->
            <div class="flex h-48 w-80 items-center justify-center text-sm" data-testid="logo-frame-loading">
                {failed ? '' : 'コマを取り出しています…'}
            </div>
        {/if}
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
