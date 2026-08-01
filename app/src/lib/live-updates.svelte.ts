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
