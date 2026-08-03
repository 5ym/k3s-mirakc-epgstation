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
    /** 画像の実寸。拡大すると変わるので、座標の戻し計算はこれを見る */
    let shownWidth = $state(0);
    let shownHeight = $state(0);
    /** 読み込みに失敗したコマ。位置を変えてもらう */
    let failed = $state(false);

    /**
     * 右上を拡大して出す。
     *
     * 局ロゴはほぼ右上にある。画面全体を出すと、その一角は指でも掴みにくいほど
     * 小さくなる。既定で寄せておき、そうでない局のために全体へ戻せるようにする。
     */
    let zoomed = $state(true);
    const SCALE = 2.5;

    /** 表示上の矩形 (画像の中の座標) */
    let box = $state<{ x: number; y: number; w: number; h: number } | null>(null);
    /** 掴んでいるもの。新しく引いているのか、今の枠を動かしているのか */
    let drag: { mode: 'draw' | 'move'; x: number; y: number; box: typeof box } | null = null;

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

    /**
     * logoframe が**いま覚えているロゴ**。
     *
     * 覚えているものが絵になっていないことがある。自動探索は「画面の右上にずっと
     * 同じ縁があること」しか見ないので、ロゴではない縁 (常時出ている枠や下地) を
     * 拾うと、毎フレーム合致するのに雑音のまま残る。実機の TOKYO MX がこれで、
     * 確かめる手立てが無いと「なぜ当たらないのか」が分からなかった。
     */
    let learned = $state<{ url: string; area: string; depth: number } | null>(null);
    /** これを下回る濃さは、ロゴではない何かを覚えているとみなす */
    const FAINT = 500;
    $effect(() => {
        // 位置を教え直すと覚えているものは捨てられる。保存後に消えるのが正しい
        void area;
        const controller = new AbortController();
        let url: string | null = null;
        void (async () => {
            try {
                const res = await fetch(`/api/services/${serviceId}/logo-data`, {
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error(String(res.status));
                const blob = await res.blob();
                url = URL.createObjectURL(blob);
                learned = {
                    url,
                    area: res.headers.get('X-Logo-Area') ?? '',
                    depth: Number(res.headers.get('X-Logo-Depth')),
                };
            } catch {
                // まだ1本も録っていない局。覚えているものが無いのは普通のこと
                learned = null;
            }
        })();
        return () => {
            controller.abort();
            if (url !== null) URL.revokeObjectURL(url);
        };
    });

    /** 記録されているコマの座標 ↔ 画面上の座標。倍率は横と縦で違う */
    const scale = $derived(
        frame === null || shownWidth === 0 || shownHeight === 0
            ? null
            : { x: shownWidth / frame.width, y: shownHeight / frame.height },
    );

    /**
     * 覚えてある範囲を、そのまま掴める枠として置く。
     *
     * **どこに設定されているのかが画面から分からなかった。** 数字だけ出していた頃は、
     * 直したくても一から囲い直すしかなかった。出しておけば、掴んで動かすだけで済む。
     */
    let placed = $state('');
    $effect(() => {
        const s = scale;
        if (s === null || area === null || area === '') return;
        // 同じ範囲を置き直さない (引いた枠を毎回上書きしてしまう)
        if (placed === area) return;
        const [x, y, w, h] = area.split(',').map(Number);
        if (![x, y, w, h].every(Number.isFinite)) return;
        placed = area;
        box = { x: x * s.x, y: y * s.y, w: w * s.x, h: h * s.y };
    });

    /** 囲ってもらった矩形を、記録されているコマの座標に直す */
    const value = $derived.by(() => {
        if (box === null || scale === null) return '';
        return [
            Math.max(0, Math.round(box.x / scale.x)),
            Math.max(0, Math.round(box.y / scale.y)),
            Math.round(box.w / scale.x),
            Math.round(box.h / scale.y),
        ].join(',');
    });

    /** 覚えてあるものと同じか。押しても何も変わらないボタンを出さないため */
    const unchanged = $derived(value !== '' && value === area);

    function at_(event: PointerEvent): { x: number; y: number } {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    /** その点が今の枠の中か。中なら動かす、外なら引き直す */
    function inside(point: { x: number; y: number }): boolean {
        if (box === null) return false;
        return point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
    }

    function down(event: PointerEvent): void {
        if (event.button !== 0) return;
        const point = at_(event);
        drag = inside(point) ? { mode: 'move', ...point, box } : { mode: 'draw', ...point, box: null };
        if (drag.mode === 'draw') box = { ...point, w: 0, h: 0 };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function move(event: PointerEvent): void {
        if (drag === null) return;
        const now = at_(event);
        if (drag.mode === 'move') {
            const from = drag.box;
            if (from === null) return;
            // 画像の外へは出さない。出すと logoframe に画面外の座標が渡る
            const w = shownWidth || Number.POSITIVE_INFINITY;
            const h = shownHeight || Number.POSITIVE_INFINITY;
            box = {
                ...from,
                x: Math.min(Math.max(0, from.x + (now.x - drag.x)), Math.max(0, w - from.w)),
                y: Math.min(Math.max(0, from.y + (now.y - drag.y)), Math.max(0, h - from.h)),
            };
            return;
        }
        // どちらへ引いても同じ矩形になるようにする
        box = {
            x: Math.min(drag.x, now.x),
            y: Math.min(drag.y, now.y),
            w: Math.abs(now.x - drag.x),
            h: Math.abs(now.y - drag.y),
        };
    }

    function up(): void {
        const mode = drag?.mode;
        drag = null;
        // 押しただけ (掴み損ね) は選択とみなさない。動かしたぶんには消さない
        if (mode === 'draw' && box !== null && (box.w < 8 || box.h < 8)) box = null;
    }
</script>

<div class="mt-3" data-testid="logo-area">
    <div class="text-sm font-medium">ロゴの位置を教える</div>
    <p class="text-base-content/70 mt-1 text-sm">
        {serviceName} のロゴでCMを判定できませんでした。ロゴが出ているコマまで送って、
        <strong>ロゴを四角で囲って</strong>ください。枠は<strong>掴んで動かせます</strong>。
        次のエンコードから使います。
    </p>

    <!--
        覚えているものを見せる。絵になっていないことがあり (ロゴではない縁を拾った)、
        それを確かめる手立てが無いと「なぜ当たらないのか」が分からなかった
    -->
    {#if learned !== null}
        <div
            class="bg-base-200 mt-2 flex flex-wrap items-center gap-3 rounded p-2"
            data-testid="logo-learned"
        >
            <img
                src={learned.url}
                alt="いま覚えているロゴ"
                class="bg-neutral max-h-32 rounded"
                style="image-rendering: pixelated"
                data-testid="logo-learned-image"
            />
            <div class="text-xs">
                <div class="font-medium">いま覚えているロゴ</div>
                <div class="text-base-content/60 mt-0.5 font-mono">{learned.area}</div>
                <div class="text-base-content/60" data-testid="logo-learned-depth">
                    濃さ {learned.depth} / 1000
                </div>
                {#if learned.depth < FAINT}
                    <!--
                        薄いものは、毎フレーム合致するのに絵にならない。
                        実機の TOKYO MX は 268 で、中身は横縞の雑音だった
                    -->
                    <div class="text-warning mt-0.5" data-testid="logo-learned-faint">
                        薄すぎます。ロゴではない縁を覚えている可能性が高いです
                    </div>
                {/if}
                <div class="text-base-content/60 mt-0.5">
                    濃さを明るさにした白黒です (いちばん濃いところが白)。位置を教えると覚え直します。
                </div>
            </div>
        </div>
    {/if}

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
        <!-- ロゴはほぼ右上。全体を出すとその一角が小さすぎて掴めない -->
        <label class="flex items-center gap-1 text-xs">
            <input
                type="checkbox"
                class="checkbox checkbox-xs"
                bind:checked={zoomed}
                data-testid="logo-zoom"
            />
            右上を拡大
        </label>
        <span class="text-base-content/60 text-xs">ロゴが出ていない場面なら位置を変えてください</span>
    </div>

    <!--
        画像の上で掴んで引く。canvas は使わない (画像に重ねた div で足りるうえ、
        拡大縮小の計算が1箇所で済む)。

        拡大は**外側で切り取る**だけにしてある。中の画像と枠は同じ入れ物に居るので、
        倍率が変わっても座標の計算は1つのまま
    -->
    <div class="bg-base-200 mt-2 max-w-full overflow-hidden" data-testid="logo-viewport">
        <div
            class="relative touch-none select-none"
            class:ml-auto={zoomed}
            style={zoomed ? `width:${SCALE * 100}%` : 'width:100%'}
            onpointerdown={down}
            onpointermove={move}
            onpointerup={up}
            role="presentation"
        >
            {#if frame !== null}
                <img
                    src={frame.url}
                    alt="ロゴの位置を選ぶためのコマ"
                    class="block w-full"
                    bind:clientWidth={shownWidth}
                    bind:clientHeight={shownHeight}
                    data-testid="logo-frame"
                />
            {:else}
                <!-- 取り出している間も掴む場所を残しておく。出た瞬間に大きさが変わらないように -->
                <div class="flex h-48 items-center justify-center text-sm" data-testid="logo-frame-loading">
                    {failed ? '' : 'コマを取り出しています…'}
                </div>
            {/if}
            {#if box !== null}
                <div
                    class="border-primary bg-primary/20 pointer-events-none absolute border-2"
                    style="left:{box.x}px; top:{box.y}px; width:{box.w}px; height:{box.h}px;"
                    data-testid="logo-box"
                ></div>
            {/if}
        </div>
    </div>
    {#if zoomed}
        <!-- 切り取って出しているので、見えていない側があることは言っておく -->
        <p class="text-base-content/60 mt-1 text-xs">
            右上だけを{SCALE}倍で出しています。ロゴが他の隅にある局は「右上を拡大」を外してください。
        </p>
    {/if}

    {#if failed}
        <div class="text-error mt-1 text-sm" data-testid="logo-frame-error">
            そのコマを取り出せませんでした。位置を変えてみてください。
        </div>
    {/if}

    <form method="POST" action="?/logoArea" use:submitting class="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="serviceId" value={serviceId} />
        <input type="hidden" name="area" {value} />
        <button class="btn btn-sm btn-primary" disabled={value === '' || unchanged} data-testid="logo-save">
            この位置で覚える
        </button>
        <span class="text-base-content/60 font-mono text-xs" data-testid="logo-value">
            {value === '' ? '囲ってください' : unchanged ? `いまの設定: ${value}` : value}
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
