/**
 * ライブ視聴。**チューナーを開いて、焼いて、繋いでいる人に配る。**
 *
 *     エージェント (MPEG-TS) → ffmpeg (fMP4) → 割る → WebSocket → MSE
 *
 * [stream.md](../../../docs/stream.md) §4 の1番目にあたる。**字幕は同じ
 * WebSocket に相乗りする** (`captions.ts`)。あちらは局までで決まるので、
 * 焼き方 (コマ数・音声) では分けない。データ放送 (§5.5) はまだ。
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

import { type Audio, type AudioTrack, audioTracks, pickTrack } from '$lib/arib';
import { CHANNEL, type Notice } from '$lib/live';
import { Fmp4Splitter } from '$lib/ts/fmp4';
import { frame, watchCaptions } from './captions';
import { config } from './config';
import { queryOne } from './db';
import { deinterlace, smoothMotionFor } from './encoder';
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
 * - `-fflags nobuffer` … 読む側で溜めない
 * - `-probesize` … **開いてから絵が出るまでの待ちの、削れる部分。** 既定の 5MB は
 *   実機の放送で 2.2 秒ぶんにあたる (毎秒 2.1MB)。実測した ffmpeg の立ち上がり:
 *
 *       1.5MB → 1429 ms      400KB → 741 / 689 / 707 / 766 ms
 *       800KB →  972 ms      200KB → 754 ms  ← これ以上は縮まない
 *
 *   **750ms 前後に床がある。** 放送の MPEG-2 は GOP の頭 (I フレーム) が来る
 *   まで焼き始められないためで、解析待ちをいくら削ってもここは残る。
 *   床に着く 400KB を採る。0.19 秒ぶんにあたり、PAT/PMT はおよそ 0.1 秒周期
 *   なので、選局直後のどこから始まっても2周ぶんは入る
 * - `-tune zerolatency` … B フレームを作らない (作ると必ず遅れる)
 * - `-frag_duration` … 0.05秒ぶんずつ moof/mdat を出す。既定では ffmpeg が
 *   数秒溜めてから出すので、その場でライブでなくなる
 * - `-copyts` … 元TSの90kHz PTS を保つ。第2段階で字幕と揃えるのに要る
 *
 * ## コマごとに切らない
 *
 * `frag_every_frame` にすると、**映像だけ・音声だけの塊が交互に並ぶ**。
 * mp4 の多重化はトラックごとにコマの来る間隔が違うためで、受け側の MSE は
 * その1つ1つを別の区切りとして扱う。結果、映像と音声が別々に並べ直されて、
 * 絵は絶えず引っかかり、音はずれる。時間で切れば1つの塊に両方入る。
 *
 * **どこまで細かくできるかは音声のコマが決める。** AAC は 1024 標本 = 48kHz で
 * 約 21ms なので、それより短く切ると音声の入らない塊が出る。実機で数えた
 * 「塊あたりのトラック数」(2.00 が両方入っている状態):
 *
 *     0.20秒 → 毎秒 6個  1.93      0.05秒 → 毎秒 21個  1.94
 *     0.10秒 → 毎秒 11個 1.93      0.033秒→ 毎秒 32個  1.94
 *                                  0.016秒→ 毎秒 64個  1.74 ← 崩れる
 *
 * 0.05秒を採る。0.033秒でも保つが、音声のコマ (21ms) に近すぎる。
 *
 * ## `-flags low_delay` は付けない
 *
 * `-i` より前に書くと**エンコーダではなくデコーダに効く**。放送の MPEG-2 には
 * B フレームがあるので、この指定を受けたデコーダは表示順ではなく**復号順**で
 * 絵を出す。結果、1枚進んでは戻るように見える。
 *
 * 実測 (NHK総合の高校野球・本物の 60i): 隣り合うコマの差が交互に大小し、
 * その比は 2.17。外すと 1.11 に落ち、元の素材のフィールドを直に測った
 * 値 (1.02) に並ぶ。エンコーダ側の遅れは `-tune zerolatency` が見ている。
 *
 * **インタレ解除は録画と同じ判断で行う** (`encoder.deinterlace`)。放送は 1080i
 * なので、解かずにブラウザへ渡すと動きのある場面が櫛状になる。国内アニメだけ
 * コマ数を倍にしないのも録画と揃える — 元が毎秒24コマ前後なので、倍にしても
 * 同じ絵が並ぶだけで、CPU だけ倍かかる。
 *
 * ## 局を名指しで選ぶ
 *
 * **1本の物理チャンネルに複数の局が乗っている。** `0:v:0` は「最初に見つけた
 * 映像」でしかないので、MX2 を選んでも MX1 の絵が出うる。実機の T26 を調べると
 * 局が4つ (Eテレ1/2/3 と**ワンセグ**) 並んでいて、ワンセグは 320x180 の H.264 —
 * それを掴む目まである。`0:p:<局>:v:0` なら選んだ局の中から選ぶ。
 *
 * ## 多重音声
 *
 * 「多重音声」と呼ばれるものは2通りある。**どちらも、焼くときに1本へ決める。**
 *
 * - **デュアルモノ** … 音声は1本で、左に主音声・右に副音声 (ARIB STD-B32)。
 *   そのままステレオにすると両方同時に鳴るので、選ばれた側を両耳へ配り直す
 *   (`pan`)。**録画と同じ見分け方** (`arib.ts` の `DUAL_MONO`)。録画は左右を
 *   2トラックに分けるが、こちらは器が1つなので片方を採る
 * - **複数の音声** … 音声そのものが2本以上入っている (解説放送など)。
 *   `-map` で何本目かを名指しする
 *
 * 選べるものを組み立てるのは `arib.audioTracks`。**画面には平らな一覧に見せる** —
 * 見ている人にとってはどちらも「音声を選ぶ」1つの操作でしかない。
 *
 * @param program 放送が名乗っている番号 (`NowPlaying.program`)。0以下なら
 *   最初に見つけた映像 (従来どおり)
 * @param smooth 60コマ/秒で出すか。国内アニメだけ false
 * @param audio どの音声を、どちら側で出すか
 */
export function encodeArgs(program: number, smooth: boolean, audio: AudioTrack): string[] {
    const from = Number.isFinite(program) && program > 0 ? `0:p:${program}` : '0';
    // デュアルモノは片側だけを両耳へ。そのままだと左右から別の言語が同時に鳴る
    const pan =
        audio.side === 'main'
            ? 'pan=stereo|c0=c0|c1=c0'
            : audio.side === 'sub'
              ? 'pan=stereo|c0=c1|c1=c1'
              : null;
    return [
        '-hide_banner',
        '-loglevel',
        'error',
        '-fflags',
        'nobuffer',
        // 立ち上がりの、削れる部分。これ以上小さくしても縮まない (上の説明)
        '-probesize',
        '400000',
        '-copyts',
        '-i',
        'pipe:0',
        // インタレ解除。放送は 1080i なので、解かずに渡すと動きが櫛状になる
        '-vf',
        deinterlace(smooth),
        '-map',
        `${from}:v:0`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'zerolatency',
        '-g',
        '60',
        // 何本目の音声か。複数入っている放送では 0 が主とは限らない
        '-map',
        `${from}:a:${audio.stream}`,
        ...(pan === null ? [] : ['-af', pan]),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ac',
        '2',
        '-f',
        'mp4',
        '-movflags',
        '+empty_moov+default_base_moof',
        // 0.05秒ぶんずつ。これ以上細かくすると音声の入らない塊が出る (上の説明)
        '-frag_duration',
        '50000',
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
        /** 局の内部ID (`services.id`)。相乗りの目印に使う */
        readonly serviceId: number,
        /** 放送が名乗っている番号。**ffmpeg に渡すのはこちら** (NowPlaying の説明) */
        readonly program: number,
        /** 60コマ/秒で出すか。国内アニメだけ false */
        readonly smooth: boolean,
        /** どの音声を、どちら側で出すか */
        readonly audio: AudioTrack,
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

            const proc = Bun.spawn([config.ffmpeg, ...encodeArgs(this.program, this.smooth, this.audio)], {
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
        sessions.delete(key(this.channelType, this.channel, this.serviceId, this.smooth, this.audio));
    }
}

/**
 * 焼いているものの目印。**局・コマ数・音声まで含める。**
 *
 * 1本の物理チャンネルに複数の局が乗っているので、チャンネルだけでは足りない —
 * 局を名指しで選んでいる以上、出てくる絵が局ごとに違う。コマ数も同じで、
 * 国内アニメを見ている人と実写を見ている人では違う。**音声も同じ** —
 * 二カ国語を主音声で見ている人と副音声で見ている人は別のものを焼いている。
 * 混ぜると片方が意図しないものを見ることになる。チューナーはエージェント側で
 * 相乗りになるので、増えるのは ffmpeg だけ。
 */
const key = (type: string, channel: string, serviceId: number, smooth: boolean, audio: AudioTrack) =>
    `${type}:${channel}:${serviceId}:${smooth ? 60 : 30}:${audio.id}`;
const sessions = new Map<string, Session>();

/** 見に行く。既に同じものを焼いていれば相乗りする */
function watch(
    channelType: string,
    channel: string,
    serviceId: number,
    now: NowPlaying,
    viewer: Viewer,
): Session {
    const id = key(channelType, channel, serviceId, now.smooth, now.audio);
    let session = sessions.get(id);
    if (session === undefined) {
        session = new Session(channelType, channel, serviceId, now.program, now.smooth, now.audio);
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
    /** いま字幕を受けている局。**焼き方が変わっても、局が同じなら切らない** */
    let captionKey = '';
    let dropCaptions: (() => void) | null = null;

    const leave = () => {
        if (current === null) return;
        current.remove(viewer);
        // **最後の1人が抜けたら畳む。** 残すとチューナーを掴んだままになる
        if (current.empty) current.stop();
        current = null;
    };

    /**
     * 字幕を受け直す。**局が同じなら何もしない。**
     *
     * 字幕は局で決まるので、音声を選び直しただけで切ってはいけない。
     * 切ると ffmpeg を起こし直すことになり、次の字幕が出るまで数十秒あく
     * (字幕は次が来るまで出しっぱなしのものなので、途切れがそのまま見える)
     */
    const followCaptions = (channelType: string, channel: string, serviceId: number, program: number) => {
        const id = `${channelType}:${channel}:${serviceId}`;
        if (id === captionKey) return;
        dropCaptions?.();
        captionKey = id;
        dropCaptions = watchCaptions(channelType, channel, serviceId, program, (caption) => {
            const { kind, pts, data } = frame(caption);
            connection.send(kind, pts, data);
        });
    };

    connection.onmessage = (message) => {
        if (message.type !== 'tune') return;
        const channelType = typeof message.channelType === 'string' ? message.channelType : '';
        const channel = typeof message.channel === 'string' ? message.channel : '';
        const serviceId = Number(message.serviceId);
        const audio = typeof message.audio === 'string' ? message.audio : undefined;
        if (channelType === '' || channel === '') return;

        const now = nowPlaying(serviceId, audio);
        if (
            current !== null &&
            current.channelType === channelType &&
            current.channel === channel &&
            current.serviceId === serviceId &&
            current.smooth === now.smooth &&
            current.audio.id === now.audio.id
        ) {
            return;
        }

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
        const notice: Notice = {
            type: 'tuned',
            channelType,
            channel,
            codecs: CODECS,
            audio: now.audio.id,
            audios: now.audios,
        };
        connection.send(CHANNEL.control, 0n, new TextEncoder().encode(JSON.stringify(notice)));
        current = watch(channelType, channel, serviceId, now, viewer);
        // 字幕は局で決まる。焼き方が変わっただけなら切らない
        followCaptions(channelType, channel, serviceId, now.program);
    };

    connection.onclose = () => {
        leave();
        dropCaptions?.();
        dropCaptions = null;
        captionKey = '';
    };
}

export interface NowPlaying {
    /**
     * 放送が名乗っている番号 (ARIB の service_id = TS の program_number)。
     * **`services.id` とは別物** — あちらは `network_id * 100000 + service_id` の
     * 内部IDで、TS の中には出てこない。**内部IDを渡すと** ffmpeg はその番号の局を
     * 探して見つけられず、**絵も音も出ない** (実機でやった)。ffmpeg に渡すのはこちら
     */
    program: number;
    smooth: boolean;
    /** 選べる音声。画面へそのまま送る */
    audios: AudioTrack[];
    /** そのうち焼くもの */
    audio: AudioTrack;
}

/**
 * いま流れている番組から、焼き方を決める。**番組表を頼りにする。**
 *
 * - 局の番号 … ffmpeg に名指しさせる `program_number` (`NowPlaying.program`)
 * - コマ数 … 国内アニメだけ倍にしない (`smoothMotionFor`)。**分からなければ
 *   実写として扱う** — 放送の大半は実写で、アニメを実写扱いにしても絵は
 *   変わらないが、逆は動きが落ちる
 * - 音声 … 番組表の `audios` から、選べるものを組み立てる (`arib.audioTracks`)。
 *   **古い行には `audios` が入っていない**ので、そのときは `audio_type` だけで
 *   デュアルモノかどうかを見る。どちらも無ければ「そのまま出す」1つ
 *
 * @param serviceId 局の内部ID (`services.id`)。画面から届くのはこれ
 * @param wanted 画面が頼んできた音声 (`AudioTrack.id`)。無いものなら先頭
 */
function nowPlaying(serviceId: number, wanted: string | undefined): NowPlaying {
    const decide = (program: number, genres: string | null, audios: Audio[]): NowPlaying => {
        const tracks = audioTracks(audios);
        return {
            program,
            smooth: smoothMotionFor(genres),
            audios: tracks,
            audio: pickTrack(tracks, wanted),
        };
    };

    if (!Number.isFinite(serviceId)) return decide(0, null, []);
    const at = Date.now();
    const service = queryOne<{ service_id: number }>(
        `SELECT service_id FROM services WHERE id = ?`,
        serviceId,
    );
    const program = queryOne<{
        genre_detail: string | null;
        audio_type: number | null;
        audios: string | null;
    }>(
        `SELECT genre_detail, audio_type, audios FROM programs
         WHERE service_id = ? AND start_at <= ? AND end_at > ?`,
        serviceId,
        at,
        at,
    );

    return decide(service?.service_id ?? 0, program?.genre_detail ?? null, parseAudios(program));
}

/**
 * 番組表が持っている音声の構成を読む。**壊れていても止まらない。**
 *
 * `audios` は放送から拾ったものを JSON で持っているだけなので、形が違うことは
 * ありうる。読めなければ `audio_type` に落とし、それも無ければ何も無いことにする —
 * どの道 `audioTracks` が「そのまま出す」1つを返す
 */
function parseAudios(row: { audio_type: number | null; audios: string | null } | undefined): Audio[] {
    if (row === undefined) return [];
    try {
        const parsed: unknown = JSON.parse(row.audios ?? 'null');
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as Audio[];
    } catch {
        // 読めなかった。下の `audio_type` で見る
    }
    return row.audio_type === null ? [] : [{ componentType: row.audio_type }];
}

/** テスト用。掴んだままのものを残さない */
export function stopAll(): void {
    for (const session of [...sessions.values()]) session.stop();
}
