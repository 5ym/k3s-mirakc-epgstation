/**
 * ライブ視聴の受け側。**WebSocket で受けて MSE へ流す。**
 *
 * MSE は取ってこない。`appendBuffer()` に渡すバイト列をどこから持ってくるかは
 * こちら次第で、denpa は WebSocket から受ける ([stream.md](../../docs/stream.md) §5.3)。
 * 同じ1本に字幕もデータ放送も相乗りする作りなので、種別で振り分ける。
 */

import { CHANNEL, type Command, type Notice, SOCKET_PATH } from '$lib/live';

export type LiveState = 'idle' | 'connecting' | 'playing' | 'error';

/** 前回見ていたチャンネルの控え */
const LAST = 'denpa:live:last';

export interface Tuned {
    channelType: string;
    channel: string;
    /** どの局を選んだか。いま流れている番組からコマ数を決めるのに要る */
    serviceId: number;
}

/** 前回見ていたチャンネル。**初手はここから開く** */
export function lastChannel(): Tuned | null {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(LAST) ?? 'null');
        if (typeof saved !== 'object' || saved === null) return null;
        const { channelType, channel, serviceId } = saved as Record<string, unknown>;
        if (typeof channelType !== 'string' || typeof channel !== 'string') return null;
        return { channelType, channel, serviceId: Number(serviceId) };
    } catch {
        return null;
    }
}

export function livePlayer() {
    let state = $state<LiveState>('idle');
    let message = $state('');
    let tuned = $state<Tuned | null>(null);

    let socket: WebSocket | null = null;
    let source: MediaSource | null = null;
    let buffer: SourceBuffer | null = null;
    /**
     * 追加待ちの列。**`appendBuffer` は1つずつしか受け付けない** —
     * 前のが終わる前に呼ぶと `InvalidStateError` で止まる
     */
    const pending: Uint8Array[] = [];

    function drain(): void {
        if (buffer === null || buffer.updating || pending.length === 0) return;
        const next = pending.shift();
        if (next === undefined) return;
        try {
            buffer.appendBuffer(next as BufferSource);
        } catch {
            // 追いつけなくなった。次の init から入り直す
            pending.length = 0;
        }
    }

    /**
     * 溜まったぶんを捨てる。**放送は待ってくれない。**
     *
     * 見ている人が別のタブへ行くと、その間ぶん溜まって戻ってきたときに
     * 何分も遅れて再生される。持つのは直近だけにして、常に端へ寄せる。
     */
    function trim(video: HTMLVideoElement): void {
        if (buffer === null || buffer.updating || buffer.buffered.length === 0) return;
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        if (end - video.currentTime > 10) video.currentTime = end - 0.5;
    }

    function reset(): void {
        socket?.close();
        socket = null;
        buffer = null;
        source = null;
        pending.length = 0;
    }

    async function tune(video: HTMLVideoElement, target: Tuned): Promise<void> {
        reset();
        state = 'connecting';
        message = '';
        tuned = target;
        localStorage.setItem(LAST, JSON.stringify(target));

        /*
         * **札を先に取る。** ブラウザは WebSocket の握手に `Authorization` を
         * 付けてくれないので、認証を通れることをここで示す (`tickets.ts`)
         */
        let ticket: string;
        try {
            const res = await fetch('/api/live/ticket', { method: 'POST' });
            if (!res.ok) throw new Error(String(res.status));
            ticket = ((await res.json()) as { ticket: string }).ticket;
        } catch {
            state = 'error';
            message = '繋ぐ許可を取れませんでした';
            return;
        }

        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${scheme}://${location.host}${SOCKET_PATH}?ticket=${ticket}`);
        ws.binaryType = 'arraybuffer';
        socket = ws;

        ws.onopen = () => {
            const command: Command = {
                type: 'tune',
                channelType: target.channelType,
                channel: target.channel,
                serviceId: target.serviceId,
            };
            ws.send(JSON.stringify(command));
        };

        ws.onerror = () => {
            if (state !== 'playing') {
                state = 'error';
                message = '繋がりませんでした';
            }
        };

        ws.onclose = () => {
            if (socket === ws && state !== 'error') state = 'idle';
        };

        ws.onmessage = (event) => {
            const data = event.data as ArrayBuffer;
            const kind = new DataView(data).getUint8(0);
            const body = new Uint8Array(data, 9);

            if (kind === CHANNEL.control) {
                const notice = JSON.parse(new TextDecoder().decode(body)) as Notice;
                if (notice.type === 'error') {
                    state = 'error';
                    message = notice.message;
                } else if (notice.type === 'tuned') {
                    start(video, notice.codecs);
                }
                return;
            }

            if (kind === CHANNEL.videoInit) {
                /*
                 * **init が来たら作り直す。** チャンネルを変えると器も変わるので、
                 * 前の SourceBuffer に足すと中身が混ざって再生が止まる
                 */
                pending.length = 0;
                if (buffer !== null && source?.readyState === 'open') {
                    try {
                        buffer.abort();
                    } catch {
                        // 追加中でなければ投げる。気にしない
                    }
                }
            }
            if (kind === CHANNEL.videoInit || kind === CHANNEL.videoMedia) {
                pending.push(body);
                drain();
            }
        };
    }

    /** 器を用意する。`codecs` はサーバが焼き方から決めて送ってくる */
    function start(video: HTMLVideoElement, codecs: string): void {
        if (!('MediaSource' in globalThis) || !MediaSource.isTypeSupported(codecs)) {
            state = 'error';
            message = 'この端末では再生できない形式です';
            return;
        }
        const media = new MediaSource();
        source = media;
        video.src = URL.createObjectURL(media);
        media.addEventListener(
            'sourceopen',
            () => {
                URL.revokeObjectURL(video.src);
                buffer = media.addSourceBuffer(codecs);
                buffer.mode = 'sequence';
                buffer.addEventListener('updateend', () => {
                    drain();
                    trim(video);
                });
                state = 'playing';
                void video.play().catch(() => {
                    /* 自動再生を止められた。押せば出る */
                });
                drain();
            },
            { once: true },
        );
    }

    return {
        get state() {
            return state;
        },
        get message() {
            return message;
        },
        get tuned() {
            return tuned;
        },
        tune,
        stop: reset,
    };
}
