import { invalidateAll } from '$app/navigation';

/**
 * サーバからの通知を受けて画面を読み直す。
 *
 * 短時間に何度も来ることがある(録画開始とエンコード投入など)ので、
 * 少しまとめてから1回だけ読み直す。
 */
export function liveUpdates(events: string[]): void {
    $effect(() => {
        const source = new EventSource('/api/events');
        let timer: ReturnType<typeof setTimeout> | null = null;

        const refresh = () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => void invalidateAll(), 200);
        };

        for (const event of events) source.addEventListener(event, refresh);

        return () => {
            if (timer !== null) clearTimeout(timer);
            source.close();
        };
    });
}

/** 前に届いた中身を持ったままの入れ物 */
export interface Held<T> {
    /** 最後に届いた中身。まだ一度も届いていないときだけ undefined */
    readonly value: T | undefined;
}

/**
 * 読み直している間、**前に届いた中身を出したままにする**。
 *
 * 相手待ちの読み込みは promise のまま画面へ渡している (`load` の戻り値)。
 * `{#await}` に直に食わせると、読み直すたびに新しい promise に変わって
 * 待ち状態へ戻るので、**中身がいったん消えてから同じものが描き直される**。
 * チューナー画面は知らせが来るたびに読み直すので、表が数百ミリ秒ごとに
 * 消えては現れ、目に見えてちらついていた。
 *
 * 中身を持っておいて、新しいものが届いたときだけ差し替える。表の行は
 * キー付きで並べてあるので、同じ中身なら Svelte は何も描き直さない
 * (= 変わったところだけが変わる)。
 */
export function held<T>(source: () => Promise<T>): Held<T> {
    let value = $state<T | undefined>(undefined);

    $effect(() => {
        const promise = source();
        // 追い越しがあると古いほうで上書きしてしまう
        let stale = false;
        promise.then(
            (next) => {
                if (!stale) value = next;
            },
            // 失敗しても前の中身をそのまま出しておく。握り潰さないと未処理の
            // 拒否になって、画面と関係のないところで落ちる
            () => {},
        );
        return () => {
            stale = true;
        };
    });

    return {
        get value() {
            return value;
        },
    };
}
