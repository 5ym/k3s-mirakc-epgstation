/**
 * ライブ視聴の受け側。**WebSocket で受けて MSE へ流す。**
 *
 * MSE は取ってこない。`appendBuffer()` に渡すバイト列をどこから持ってくるかは
 * こちら次第で、denpa は WebSocket から受ける ([stream.md](../../docs/stream.md) §5.3)。
 * 同じ1本に字幕もデータ放送も相乗りする作りなので、種別で振り分ける。
 */

import { CHANNEL, type Command, type Notice, SOCKET_PATH } from '$lib/live';
import { FLOOR, nextTarget, pacing } from '$lib/ts/pacing';

export type LiveState = 'idle' | 'connecting' | 'playing' | 'error';

/** 前回見ていたチャンネルの控え */
const LAST = 'denpa:live:last';

/**
 * 遅れて見られる長さ (秒)。**止めている間も受け取り続けるので、上限が要る。**
 *
 * ブラウザが抱えられる量には上限があり、超えると `appendBuffer` が落ちる。
 * 5分あれば、電話に出て戻ってくるくらいは追いつける。
 */
const KEEP = 300;
/** 貯める量を決め直す間隔 (ms)。塊は毎秒20個来るので、そのたびには回さない */
const SETTLE_EVERY = 5_000;
/**
 * 選局や跳んだ直後、詰まりを数えない間 (ms)。
 *
 * **自分で起こした詰まりで貯める量を増やさない。** 器を作り直せば必ず
 * `waiting` が上がるし、跳べば読み込み直しになる。宅外で本当に届かない
 * のとは別ものなので、混ぜると遅延が伸びたまま戻らない
 */
const GRACE = 3_000;

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
    /** 止めているか。**押して止めた間も受け取り続ける** */
    let paused = $state(false);
    /** 放送の今に張り付いているか。離れていれば「ライブへ」を出す */
    let live = $state(true);
    /** どれだけ貯めているか (秒)。詰まると伸び、無事が続くと縮む */
    let target = $state(FLOOR);
    /**
     * どこまで戻れて、いまどこに居るか。**操作の帯を描くのに使う。**
     *
     * 0.1秒刻みで入れ直す。塊は毎秒20個来るので、そのたびに動かすと
     * 画面を無駄に描き直すことになる
     */
    let oldest = $state(0);
    let newest = $state(0);
    let position = $state(0);

    let socket: WebSocket | null = null;
    let source: MediaSource | null = null;
    let buffer: SourceBuffer | null = null;
    /** いま鳴らしている器。押して音を出すのに要る */
    let element: HTMLVideoElement | null = null;
    /** もう再生を始めたか。始めるまでは貯める */
    let running = false;
    /** 最後に詰まった時刻。無事が続いたかを見る */
    let lastStall = 0;
    /** 前回 `nextTarget` を回してから詰まったか */
    let stalled = false;
    /** 最後に `nextTarget` を回した時刻 */
    let lastSettled = 0;
    /**
     * この時刻まで、詰まっても数えない。**自分で起こした詰まりを数えないため。**
     *
     * 選局した直後と、跳んだ直後は必ず `waiting` が上がる。数えていた頃は
     * それだけで貯める量が増え、遅延が伸びたまま戻らなかった (縮むのは
     * 45秒に 0.15 秒ずつなので、1回増えると分単位で残る)。
     */
    let quiet = 0;
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
        const behind = end - video.currentTime;
        /*
         * **0.1秒刻みにする。** 塊は毎秒20個届くので、そのたびに書き換えると
         * 画面を無駄に描き直すことになる
         */
        const rounded = running ? Math.round(behind * 10) / 10 : null;
        if (rounded !== delay) delay = rounded;
        // 放送の今に張り付いているか。少しの揺れでは離れたことにしない
        const atLive = behind <= target + 1.5;
        if (atLive !== live) live = atLive;

        const tenth = (value: number) => Math.round(value * 10) / 10;
        if (tenth(buffer.buffered.start(0)) !== oldest) oldest = tenth(buffer.buffered.start(0));
        if (tenth(end) !== newest) newest = tenth(end);
        if (tenth(video.currentTime) !== position) position = tenth(video.currentTime);

        trim(end);
        settle();

        /*
         * **押して止めている間は動かさない。** 受け取りは続けているので溜まって
         * いくが、そこへ跳ばせると「止めた所から見る」ができなくなる。
         * 追いかけ直すのは「ライブへ」を押されたとき (`goLive`)
         */
        if (paused) return;

        const next = pacing({
            start: buffer.buffered.start(0),
            end,
            at: video.currentTime,
            playing: running,
            target,
        });

        if (next.seek !== null) {
            video.currentTime = next.seek;
            quiet = Date.now() + GRACE;
        }
        if (next.rate !== null) video.playbackRate = next.rate;
        if (next.play && !running) {
            running = true;
            state = 'playing';
            void play(video);
        }
    }

    /**
     * 溜まりすぎを刈る。**止めている間も受け取り続けるので、放っておくと際限なく太る。**
     *
     * ブラウザが抱えられる量には上限があり、超えると `appendBuffer` が
     * `QuotaExceededError` で落ちる。落ちるとそこから絵が出なくなるので、
     * 遅れて見られる長さに上限を設けて、古いほうから捨てる。
     */
    function trim(end: number): void {
        if (buffer === null || buffer.updating || buffer.buffered.length === 0) return;
        const cut = end - KEEP;
        if (buffer.buffered.start(0) >= cut) return;
        try {
            buffer.remove(0, cut);
        } catch {
            // 追加中だった。次の機会に
        }
    }

    /** 貯める量を決め直す。**止まったら伸ばし、無事が続いたら縮める** */
    function settle(): void {
        const now = Date.now();
        if (!stalled && now - lastSettled < SETTLE_EVERY) return;
        const settledFor = (now - lastStall) / 1000;
        const next = nextTarget(target, stalled, settledFor);
        stalled = false;
        lastSettled = now;
        if (next !== target) target = next;
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

    /** 音を止める。備え付けの操作を出さないので、こちらで用意する */
    function mute(): void {
        silenced = true;
        if (element !== null) element.muted = true;
    }

    /**
     * 止める・再開する。**止めても受け取りは続く。**
     *
     * 止めた所から見られるようにするため、再開しても追いかけ直さない
     * (`pace` が `paused` の間は何もしない)。放送に戻りたいときは `goLive`。
     */
    function toggle(): void {
        if (element === null) return;
        if (paused) {
            paused = false;
            void element.play().catch(() => {
                /* 押されて呼ばれるので断られない */
            });
        } else {
            paused = true;
            element.pause();
        }
    }

    /** 放送の今へ追いつく。**止めて見ていたぶんを飛ばす** */
    function goLive(): void {
        if (element === null || buffer === null || buffer.buffered.length === 0) return;
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        element.currentTime = Math.max(buffer.buffered.start(0), end - target);
        quiet = Date.now() + GRACE;
        if (paused) toggle();
    }

    /** 持っている範囲の中で移る。帯を押されたとき */
    function seek(to: number): void {
        if (element === null || buffer === null || buffer.buffered.length === 0) return;
        const start = buffer.buffered.start(0);
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        element.currentTime = Math.min(end, Math.max(start, to));
        quiet = Date.now() + GRACE;
    }

    function reset(): void {
        socket?.close();
        socket = null;
        buffer = null;
        source = null;
        running = false;
        delay = null;
        paused = false;
        live = true;
        oldest = 0;
        newest = 0;
        position = 0;
        pending.length = 0;
    }

    async function tune(video: HTMLVideoElement, target: Tuned): Promise<void> {
        reset();
        state = 'connecting';
        message = '';
        tuned = target;
        element = video;
        quiet = Date.now() + GRACE;
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
                /*
                 * **詰まったことを覚えておく。** 宅内と宅外で必要な貯めの量は
                 * 桁違いに違うのに、どちらから見ているかは分からない。
                 * 実際に止まったかどうかで決める (`nextTarget`)
                 */
                video.addEventListener('waiting', () => {
                    if (paused || Date.now() < quiet) return;
                    stalled = true;
                    lastStall = Date.now();
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
        /** 押して止めているか */
        get paused() {
            return paused;
        },
        /** 放送の今に張り付いているか */
        get live() {
            return live;
        },
        /** いまどれだけ貯めているか (秒)。詰まると伸びる */
        get buffering() {
            return target;
        },
        /** どこまで戻れるか (いちばん古い時刻) */
        get oldest() {
            return oldest;
        },
        /** 放送の今 (いちばん新しい時刻) */
        get newest() {
            return newest;
        },
        /** いま映している時刻 */
        get position() {
            return position;
        },
        seek,
        toggle,
        goLive,
        mute,
        tune,
        unmute,
        stop: reset,
    };
}
