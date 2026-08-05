import { detectPlatform, type Platform } from './play';

/**
 * どのプレイヤーに渡すか。**サーバが決めたものから始めて、ブラウザで直す。**
 *
 * ブラウザで判定してから出すと、判定できるまで再生ボタンが出ず、読み込み直後に
 * 一瞬消えて見えます。UA だけで分かるぶんはサーバが渡してくるので
 * (`server/play.ts`)、そこから始めます。
 *
 * **直すのは iPad のためです。** UA で Macintosh を名乗るので、タッチ点数を
 * 見ないと Mac と区別が付きません。`origin` も同じ理由でサーバの値から始めます。
 *
 * 録画一覧と番組表の両方で同じものが要ります (どちらからも録れたものを開ける)。
 */
export function playTarget(fallback: () => { platform: Platform; origin: string }) {
    let refined = $state<{ platform: Platform; origin: string } | null>(null);
    $effect(() => {
        refined = {
            platform: detectPlatform(navigator.userAgent, navigator.maxTouchPoints),
            origin: location.origin,
        };
    });
    return {
        get platform(): Platform {
            return refined?.platform ?? fallback().platform;
        },
        get origin(): string {
            return refined?.origin ?? fallback().origin;
        },
    };
}
