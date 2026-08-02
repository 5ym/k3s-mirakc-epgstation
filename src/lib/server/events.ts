/**
 * サーバ側で起きた変化をブラウザへ push するための小さな仕組み。
 *
 * これまでは画面が数秒おきに読み直していたが、
 * 「待機中のジョブが動き出した」ようにこちらが知っている変化を伝えられないのが
 * 無駄でもあり取りこぼしでもあった。
 *
 * WebSocket ではなく SSE を使う。伝えたいのはサーバ→ブラウザの一方向だけで、
 * SSE なら普通のHTTPなので逆プロキシもそのまま通る
 * (SvelteKit + adapter-node で WebSocket を扱うには自前のサーバが要る)。
 */

export type DenpaEvent = 'recordings' | 'reservations' | 'migrate' | 'scan' | 'services';

type Listener = (event: DenpaEvent) => void;

const listeners = new Set<Listener>();

export function emit(event: DenpaEvent): void {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch {
            // 1つの購読者の失敗で他に波及させない
        }
    }
}

export function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
