import { type DenpaEvent, subscribe } from '$lib/server/events';

/** 何も起きなくても切られないよう、定期的に空行を送る */
const HEARTBEAT = 25_000;

/**
 * サーバ側の変化を流し続ける (Server-Sent Events)。
 * ブラウザは受け取ったら該当画面を読み直す。
 */
export function GET() {
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            const send = (text: string) => {
                try {
                    controller.enqueue(encoder.encode(text));
                } catch {
                    // 既に閉じられていれば何もしない
                }
            };

            send(': connected\n\n');
            unsubscribe = subscribe((event: DenpaEvent) => send(`event: ${event}\ndata: 1\n\n`));
            timer = setInterval(() => send(': ping\n\n'), HEARTBEAT);
            timer.unref?.();
        },
        cancel() {
            unsubscribe?.();
            if (timer !== null) clearInterval(timer);
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            // 逆プロキシに溜め込まれると届かない
            'X-Accel-Buffering': 'no',
        },
    });
}
