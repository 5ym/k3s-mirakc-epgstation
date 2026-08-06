/**
 * ライブ視聴。**チューナーを開いて、焼いて、繋いでいる人に配る。**
 *
 *     エージェント (MPEG-TS) → ffmpeg (fMP4) → 割る → WebSocket → MSE
 *
 * [stream.md](../../../docs/stream.md) §4 の1番目にあたる。字幕 (§5.2) と
 * データ放送 (§5.5) は同じ WebSocket に相乗りさせる作りにしてあるが、
 * ここではまだ映像と音声しか流さない。
 *
 * ## 同じチャンネルは1本で焼く
 *
 * 2人が同じチャンネルを見ても、チューナーも ffmpeg も1つで足りる。
 * **数えているのは見ている人の数**で、0になったら畳む。エージェント側でも
 * 同じチャンネルは相乗りになるが、こちらで畳まないと ffmpeg が residual に残る。
 *
 * ## 途中から入ってきた人
 *
 * MSE は init セグメントを先に受け取らないと**中身を1バイトも読まない**ので、
 * 最後に流した init を持っておいて、繋いできた人に真っ先に渡す。
 */

import { CHANNEL, type Notice } from '$lib/live';
import { Fmp4Splitter } from '$lib/ts/fmp4';
import { config } from './config';
import { chunks } from './stream';
import { openChannelStream } from './tuner';
import type { Connection } from './ws';

/**
 * 焼き方。**第1段階は H.264 + AAC。**
 *
 * 狙いは AV1 + Opus (stream.md §1) だが、実機に HW エンコーダが無く
 * (`ffmpeg -hwaccels` が空)、CPU も AVX-512 を持たない世代なので、
 * ソフトウェアの AV1 は賭けになる。設計書も「コーデックは段階ではなく設定」と
 * 書いているので、まず確実に出るほうで経路を通す。
 *
 * - `-fflags nobuffer` `-flags low_delay` … 溜めない
 * - `-tune zerolatency` … B フレームを作らない (作ると必ず遅れる)
 * - `frag_every_frame` … フレームごとに moof/mdat を出す。これが無いと
 *   ffmpeg は数秒ぶん溜めてから出すので、その場でライブでなくなる
 * - `-copyts` … 元TSの90kHz PTS を保つ。第2段階で字幕と揃えるのに要る
 */
function encodeArgs(): string[] {
    return [
        '-hide_banner',
        '-loglevel',
        'error',
        '-fflags',
        'nobuffer',
        '-flags',
        'low_delay',
        '-copyts',
        '-i',
        'pipe:0',
        '-map',
        '0:v:0',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-g',
        '60',
        '-map',
        '0:a:0',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ac',
        '2',
        '-f',
        'mp4',
        '-movflags',
        '+empty_moov+frag_every_frame+default_base_moof',
        '-flush_packets',
        '1',
        'pipe:1',
    ];
}

/**
 * ブラウザに渡す codecs 文字列。**MSE はこれが合っていないと受け取らない。**
 *
 * 中身から起こすのが本筋だが (moov を読めば分かる)、第1段階は焼き方を
 * こちらで決め打ちにしているので、その組に対応する値を返す。
 * コーデックを設定で選べるようにするときに、ここも一緒に動かす。
 */
export const CODECS = 'video/mp4; codecs="avc1.640029,mp4a.40.2"';

interface Viewer {
    connection: Connection;
    /** init を渡したか。渡す前に中身を送っても MSE は捨てる */
    ready: boolean;
}

class Session {
    private readonly viewers = new Set<Viewer>();
    private readonly splitter = new Fmp4Splitter();
    private readonly aborter = new AbortController();
    private proc: ReturnType<typeof Bun.spawn> | null = null;
    /** 最後に流した init。途中から入ってきた人に真っ先に渡す */
    private init: Uint8Array | null = null;
    private stopped = false;

    constructor(
        readonly channelType: string,
        readonly channel: string,
    ) {}

    get empty(): boolean {
        return this.viewers.size === 0;
    }

    add(viewer: Viewer): void {
        this.viewers.add(viewer);
        if (this.init !== null) this.hand(viewer, CHANNEL.videoInit, this.init);
    }

    remove(viewer: Viewer): void {
        this.viewers.delete(viewer);
    }

    /**
     * 1つ渡す。**init を渡す前に中身を送らない** (MSE が捨てる)。
     *
     * 中身は詰まったら捨ててよい。**遅れて全部届くより、飛んで今が映るほうがいい** —
     * 放送は待ってくれないので、積むと際限なく太る。init は捨てない
     * (捨てるとその人には以降ずっと絵が出ない)。
     */
    private hand(viewer: Viewer, kind: number, data: Uint8Array): void {
        if (kind === CHANNEL.videoInit) viewer.ready = true;
        else if (!viewer.ready) return;
        viewer.connection.send(kind, 0n, data, kind === CHANNEL.videoMedia);
    }

    /** 焼き始める。**畳むまで戻らない** */
    async run(): Promise<void> {
        const label = `${this.channelType}:${this.channel}`;
        try {
            const stream = await openChannelStream(
                this.channelType,
                this.channel,
                this.aborter.signal,
                `live ${this.channelType}/${this.channel}`,
                config.priority.live,
            );

            const proc = Bun.spawn([config.ffmpeg, ...encodeArgs()], {
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            this.proc = proc;

            /*
             * **流し込みと汲み出しを同時に回す。** 順にやると、ffmpeg の
             * 出力を誰も読まないまま入力を書き続けることになり、パイプが詰まって
             * 両方止まる (放送は止まってくれない)
             */
            await Promise.all([this.pump(stream, proc), this.drain(proc), this.watch(proc)]);
        } catch (error) {
            if (!this.stopped) {
                console.warn(`[live] ${label}: ${error}`);
                this.tell({ type: 'error', message: '選局できませんでした' });
            }
        } finally {
            this.stop();
        }
    }

    /** エージェントから来た TS を ffmpeg へ */
    private async pump(
        stream: ReadableStream<Uint8Array>,
        proc: ReturnType<typeof Bun.spawn>,
    ): Promise<void> {
        const writer = proc.stdin as import('bun').FileSink;
        try {
            for await (const chunk of chunks(stream)) {
                if (this.stopped) break;
                writer.write(chunk);
                await writer.flush();
            }
        } finally {
            try {
                writer.end();
            } catch {
                // もう閉じている
            }
        }
    }

    /** ffmpeg が出した fMP4 を割って配る */
    private async drain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            for (const segment of this.splitter.feed(chunk)) {
                if (segment.kind === 'init') {
                    this.init = segment.data;
                    for (const viewer of this.viewers) this.hand(viewer, CHANNEL.videoInit, segment.data);
                } else {
                    for (const viewer of this.viewers) this.hand(viewer, CHANNEL.videoMedia, segment.data);
                }
            }
        }
    }

    /**
     * ffmpeg の言い分を残す。**黙って死なせない。**
     *
     * 焼けない理由 (音声が無い・解像度が変わった) はここにしか出ない。
     * 捨てていると「映像が出ない」としか分からなくなる
     */
    private async watch(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const chunk of chunks(proc.stderr as ReadableStream<Uint8Array>)) {
            const text = new TextDecoder().decode(chunk).trim();
            if (text !== '') console.warn(`[live] ${this.channelType}:${this.channel} ffmpeg: ${text}`);
        }
    }

    tell(notice: Notice): void {
        const payload = new TextEncoder().encode(JSON.stringify(notice));
        for (const viewer of this.viewers) viewer.connection.send(CHANNEL.control, 0n, payload);
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.aborter.abort();
        this.proc?.kill();
        sessions.delete(key(this.channelType, this.channel));
    }
}

const key = (type: string, channel: string) => `${type}:${channel}`;
const sessions = new Map<string, Session>();

/** 見に行く。既に誰かが見ているチャンネルなら相乗りする */
function watch(channelType: string, channel: string, viewer: Viewer): Session {
    const id = key(channelType, channel);
    let session = sessions.get(id);
    if (session === undefined) {
        session = new Session(channelType, channel);
        sessions.set(id, session);
        // 畳むのは見ている人が居なくなったとき。ここでは待たない
        void session.run();
    }
    session.add(viewer);
    return session;
}

/**
 * 1本ぶんの受け持ち。**繋いでいる間だけチューナーを掴む。**
 *
 * 接続そのものが在席の印になる (`stream.md` の「誰が見ているかが分かる」)。
 * HTTP のストリームだと切断の検出が遅れるが、WebSocket なら閉じた時点で分かる。
 */
export function attend(connection: Connection): void {
    const viewer: Viewer = { connection, ready: false };
    let current: Session | null = null;

    const leave = () => {
        if (current === null) return;
        current.remove(viewer);
        // **最後の1人が抜けたら畳む。** 残すとチューナーを掴んだままになる
        if (current.empty) current.stop();
        current = null;
    };

    connection.onmessage = (message) => {
        if (message.type !== 'tune') return;
        const channelType = typeof message.channelType === 'string' ? message.channelType : '';
        const channel = typeof message.channel === 'string' ? message.channel : '';
        if (channelType === '' || channel === '') return;
        if (current !== null && current.channelType === channelType && current.channel === channel) return;

        leave();

        /*
         * **知らせるのも印を戻すのも、乗る前に済ませる。**
         *
         * `watch` は既に誰かが見ているチャンネルなら、その場で持っている init を
         * 渡す (`Session.add`)。そのあとで `ready` を戻していた頃は、**渡した直後の
         * init を無かったことにして**いた — 以降の中身が全部 `hand` で止まり、
         * 相乗りしたときだけ絵が出ない。
         *
         * `tuned` も先に出す。器を作るのは画面側で、init はそれより先には使えない。
         */
        viewer.ready = false;
        const notice: Notice = { type: 'tuned', channelType, channel, codecs: CODECS };
        connection.send(CHANNEL.control, 0n, new TextEncoder().encode(JSON.stringify(notice)));
        current = watch(channelType, channel, viewer);
    };

    connection.onclose = leave;
}

/** テスト用。掴んだままのものを残さない */
export function stopAll(): void {
    for (const session of [...sessions.values()]) session.stop();
}
