/**
 * ライブ視聴の受け側。**WebSocket で受けて MSE へ流す。**
 *
 * MSE は取ってこない。`appendBuffer()` に渡すバイト列をどこから持ってくるかは
 * こちら次第で、denpa は WebSocket から受ける ([stream.md](../../docs/stream.md) §5.3)。
 * 同じ1本に字幕もデータ放送も相乗りする作りなので、種別で振り分ける。
 */

import { CHANNEL, type Command, type Notice, SOCKET_PATH } from '$lib/live';
import { pacing } from '$lib/ts/pacing';

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
    /** 音を止められているか。**自動再生を断られたときだけ立つ** */
    let silenced = $state(false);
    /**
     * 放送からどれだけ遅れているか (秒)。**受け取った最後の絵と、いま映して
     * いる絵の差。** ここが遅延の大半で、焼き方より効く。出しているのは、
     * 詰まりが増えていないかを見ながら詰めていくため
     */
    let delay = $state<number | null>(null);

    let socket: WebSocket | null = null;
    let source: MediaSource | null = null;
    let buffer: SourceBuffer | null = null;
    /** いま鳴らしている器。押して音を出すのに要る */
    let element: HTMLVideoElement | null = null;
    /** もう再生を始めたか。始めるまでは貯める */
    let running = false;
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
     * 再生位置を面倒みる。**届いた端でそのまま出すと、絶えず止まる。**
     *
     * 少し貯めてから始め、離れたら速めて詰める ([pacing.ts](./ts/pacing.ts))。
     * 別のタブへ行って戻ってきたときだけ跳ぶ — 跳ぶと音が切れるので、
     * 常用するとそれ自体が「かくつき」になる。
     */
    function pace(video: HTMLVideoElement): void {
        if (buffer === null || buffer.updating || buffer.buffered.length === 0) return;
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        /*
         * **0.1秒刻みにする。** 塊は毎秒20個届くので、そのたびに書き換えると
         * 画面を無駄に描き直すことになる
         */
        const behind = running ? Math.round((end - video.currentTime) * 10) / 10 : null;
        if (behind !== delay) delay = behind;

        const next = pacing({
            start: buffer.buffered.start(0),
            end,
            at: video.currentTime,
            playing: running,
        });

        if (next.seek !== null) video.currentTime = next.seek;
        if (next.rate !== null) video.playbackRate = next.rate;
        if (next.play && !running) {
            running = true;
            state = 'playing';
            void play(video);
        }
    }

    /**
     * 鳴らす。**断られたら、音を諦めて絵だけ出す。**
     *
     * 前回のチャンネルで勝手に始める作りなので、開いた直後は「押した」ことに
     * なっていない。その状態で音ありの再生を求めると、ブラウザは丸ごと断る —
     * 黙って諦めると、絵も出ないまま黒い画面が残る。
     */
    async function play(video: HTMLVideoElement): Promise<void> {
        video.muted = silenced;
        try {
            await video.play();
        } catch {
            video.muted = true;
            silenced = true;
            try {
                await video.play();
            } catch {
                // それでも駄目。備え付けの再生ボタンを押してもらう
            }
        }
    }

    /** 音を出す。**押されて呼ばれる** — ここまで来ればブラウザは断らない */
    function unmute(): void {
        silenced = false;
        if (element === null) return;
        element.muted = false;
        void element.play().catch(() => {
            /* 押したのに断られることはない */
        });
    }

    function reset(): void {
        socket?.close();
        socket = null;
        buffer = null;
        source = null;
        running = false;
        delay = null;
        pending.length = 0;
    }

    async function tune(video: HTMLVideoElement, target: Tuned): Promise<void> {
        reset();
        state = 'connecting';
        message = '';
        tuned = target;
        element = video;
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
        running = false;
        video.src = URL.createObjectURL(media);
        media.addEventListener(
            'sourceopen',
            () => {
                URL.revokeObjectURL(video.src);
                /*
                 * **終わりが無いと言っておく。**
                 *
                 * 何も言わないと、MediaSource の尺は「いま持っている中でいちばん
                 * 後ろ」になる。0.2秒ごとに中身が届くたびに尺が伸びるので、
                 * 備え付けの再生位置は右端まで行っては少し左へ戻る、を繰り返す。
                 * 放送に終わりは無いので、そう言うほうが正しい
                 */
                media.duration = Number.POSITIVE_INFINITY;
                buffer = media.addSourceBuffer(codecs);
                /*
                 * **並べ直させない** (`sequence` にしない)。焼いたものの時刻を
                 * そのまま使う。並べ直しは「届いた順に詰める」動きなので、
                 * 1つでも取りこぼすと以降ずっと映像と音声がずれる
                 */
                buffer.mode = 'segments';
                buffer.addEventListener('updateend', () => {
                    drain();
                    pace(video);
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
        /** 音を止められているか。押して出してもらう */
        get silenced() {
            return silenced;
        },
        /** 放送からどれだけ遅れているか (秒)。再生していないときは null */
        get delay() {
            return delay;
        },
        tune,
        unmute,
        stop: reset,
    };
}
