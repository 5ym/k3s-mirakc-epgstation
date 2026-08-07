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
import { ServiceFilter } from '$lib/ts/service-filter';
import { frame, TROUBLE, watchCaptions } from './captions';
import { config } from './config';
import { queryOne } from './db';
import { deinterlace, smoothMotionFor } from './encoder';
import { chunks, lines } from './stream';
import { openWhenFree } from './tuner';
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
 *
 *   **渡す前に1局へ絞るので、小さくてよい** (下の説明)。丸ごと渡していた頃は
 *   400KB でも足りないことがあった
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
 * ## 字幕とは時刻を突き合わせない
 *
 * **絶対の時刻では合わせられない。** `-copyts` で放送の時刻を保っているのは
 * ffmpeg の中までで、mp4 の多重化器は最初のパケットを 0 に詰め直す
 * (`-avoid_negative_ts disabled` も `-muxdelay 0` も効かない。実機で確認)。
 * しかもその「最初のパケット」は**音声**のことが多い — 焼かれた1コマ目の
 * 放送時刻を引く手を採ったときは、実機で 2.4 秒ずれた。
 *
 * 「いま焼いている絵より何秒前か」を添える手も外した。フィルタは符号器より
 * 先を走るので、実機で 5 秒ずれた。**どちらもこちらの都合で動く量**だった。
 *
 * いまは**届いた時点の再生位置に置いている** (`live-player.svelte.ts`)。
 * 字幕と映像は別の ffmpeg だが同じ電波を同じ速さで読んでいるので、出てくる
 * 時刻は揃う (1本の中に両方入れて測ると ±0.1 秒)。**こちらから添えるものは
 * 何も無い** — そのため `showinfo` も要らない。
 *
 * ## 局を名指しで選ぶ。**渡す前にも絞る**
 *
 * **1本の物理チャンネルに複数の局が乗っている。** `0:v:0` は「最初に見つけた
 * 映像」でしかないので、MX2 を選んでも MX1 の絵が出うる。実機の T26 を調べると
 * 局が4つ (Eテレ1/2/3 と**ワンセグ**) 並んでいて、ワンセグは 320x180 の H.264 —
 * それを掴む目まである。`0:p:<局>:v:0` なら選んだ局の中から選ぶ。
 *
 * **名指しだけでは足りない。** ffmpeg はその局を `-probesize` のぶん読む間に
 * 見つけられなければ、**そのまま終了する**。実機の tvk (T15) は tvk1/2/3 +
 * ワンセグ + データで、局ごとに14本以上のストリームがあり、400KB では
 * 読み切れずに降りていた:
 *
 *     Failed to set value '0:p:24632:v:0' for option 'map': Invalid argument
 *
 * わざと probesize を下げて、その T15 で測ったもの (3回ずつ):
 *
 *     probesize  20KB   丸ごと 0/3 通る    1局に絞る 3/3
 *     probesize  50KB   丸ごと 0/3 通る    1局に絞る 3/3
 *     probesize 120KB   丸ごと 1/3 通る    1局に絞る 3/3
 *     probesize 400KB   丸ごと 3/3 通る    1局に絞る 3/3
 *
 * **渡す前に1局へ絞れば 20KB でも通る。** 録画と同じ `ServiceFilter` を通すだけで、
 * ffmpeg が受け取るのは局が1つだけの TS になる。局を探す仕事が消えるので、
 * probesize は余裕を見て 100KB で足りる (通った 20KB の5倍)。
 *
 * 名指し (`0:p:<局>`) はそのまま残す。絞ったものに万一違う局が入っていたら、
 * **黙って別の局を映すより、そこで落ちるほうがいい**。
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
        /*
         * **失敗だけ残す。** 入口の見出しも進み具合も要らない (見ているのは
         * 焼けない理由だけ)。字幕側は `showinfo` が info で喋るぶん下げられないが、
         * こちらは喋らせるものが無い
         */
        '-loglevel',
        'error',
        '-fflags',
        'nobuffer',
        // 渡す前に1局へ絞ってあるので、これで足りる (上の説明)
        '-probesize',
        '100000',
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

    /**
     * まだ焼いているか。**畳んだものを掴んだままにしないため。**
     *
     * ffmpeg が降りると畳まれて一覧からも消えるが、**繋いでいる側は同じものを
     * 指したまま**になる。同じ局を選び直しても「もう見ている」と見なされて
     * 何も起きず、**「やり直す」を押しても直らない**
     */
    get alive(): boolean {
        return !this.stopped;
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
            /*
             * **空きが無ければ待って掛け直す** (`openWhenFree`)。チャンネルを
             * 変える一瞬だけ、前のチャンネルと合わせてチューナーが2本要る —
             * 前のを離してから頼んでいるが、離れたことがエージェントに届くのは
             * 非同期なので重なる瞬間が残る。地上波は2本しかないので、録画か
             * 番組表集めが1本使っていると、そこで断られていた
             */
            const stream = await openWhenFree(
                this.channelType,
                this.channel,
                this.aborter.signal,
                `live ${this.channelType}/${this.channel}`,
                config.priority.live,
                () => this.stopped,
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
             * 両方止まる (放送は止まってくれない)。
             *
             * **終わりは ffmpeg の終了で見る。** 汲み出しは相手が死ねば
             * すぐ終わるが、**流し込みは終わらない** — 書き込み先が閉じても
             * 例外にならないことがあり、放送は止まらないので回り続ける。
             * 3つ揃うのを待っていると、死んだことに永久に気づかない
             */
            const running = Promise.all([this.pump(stream, proc), this.drain(proc), this.watch(proc)]);
            await Promise.race([running, proc.exited]);
            // ここまで来たのは ffmpeg が自分で降りたとき。畳んだのなら stopped が立つ
            this.died(label, `ffmpeg が終了しました (${proc.exitCode ?? '不明'})`, '映像を出せませんでした');
        } catch (error) {
            this.died(label, String(error), '選局できませんでした');
        } finally {
            this.stop();
        }
    }

    /**
     * 焼けなくなったことを、**見ている人に伝える。**
     *
     * 伝えずに消えていた頃は、ffmpeg が入口で落ちても画面には何も出ず、
     * **前の絵が貼られたまま6秒たって黒くなる**だけだった (`live-player` の
     * `HOLD_MOST`)。見た目は「切り替えが 6 秒かかった」で、実際には
     * 失敗しているのに、そうとは分からない出方をする。
     *
     * 実機で出たのは tvk (T15) — 局が3つ相乗りしている TS で、`-probesize` が
     * 足りずに `-map 0:p:24632:v:0` を解決できないまま ffmpeg が降りていた。
     *
     * こちらから畳んだとき (`stop`) は言わない。見ている人が居なくなったか、
     * 選び直されたかで、どちらも知らせるようなことではない
     */
    private died(label: string, why: string, message: string): void {
        if (this.stopped) return;
        console.warn(`[live] ${label}: ${why}`);
        this.tell({ type: 'error', message });
    }

    /**
     * エージェントから来た TS を ffmpeg へ。**その局のぶんだけ渡す。**
     *
     * 録画と同じ絞り方 (`ts/service-filter.ts`)。丸ごと渡していた頃は、局が
     * 3つ乗っている TS で ffmpeg が局を見つけられずに降りていた (`encodeArgs`
     * の説明)。
     *
     * **量はほとんど減らない。** 実測は tvk で 17.6 → 16.8 Mbit/s、日テレで
     * 17.3 → 14.5 Mbit/s。相乗りしている局は**同じ ES を指している**ことが
     * 多いので (tvk1/2/3 は同じ中継を流している)、落ちるのは他局ぶんの表と
     * 詰め物だけ。狙いは量ではなく、**ffmpeg に局を探させないこと**。
     *
     * **放送の番号が分からないときは絞らない。** 絞りようが無いので、
     * 丸ごと渡して ffmpeg に最初の映像を採らせる (`encodeArgs` も同じ判断)
     */
    private async pump(
        stream: ReadableStream<Uint8Array>,
        proc: ReturnType<typeof Bun.spawn>,
    ): Promise<void> {
        const writer = proc.stdin as import('bun').FileSink;
        const filter = this.program > 0 ? new ServiceFilter(this.program) : null;
        try {
            for await (const chunk of chunks(stream)) {
                if (this.stopped) break;
                const out = filter === null ? chunk : filter.filter(chunk);
                if (out.length === 0) continue;
                writer.write(out);
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
     * ffmpeg の言い分から失敗だけ残す。
     *
     * 焼けない理由 (音声が無い・解像度が変わった) はここにしか出ない。
     * 捨てていると「映像が出ない」としか分からなくなる。
     *
     * `-loglevel error` にしてあってもなお、復号器は直せた程度のことまで
     * 喋る (放送の欠けは日常的にある)。**残すのは本当に失敗した行だけ**
     */
    private async watch(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
            if (TROUBLE.test(line)) {
                console.warn(`[live] ${this.channelType}:${this.channel} ffmpeg: ${line.trim()}`);
            }
        }
    }

    tell(notice: Notice): void {
        for (const viewer of this.viewers) this.tellOne(viewer, notice);
    }

    private tellOne(viewer: Viewer, notice: Notice): void {
        viewer.connection.send(CHANNEL.control, 0n, new TextEncoder().encode(JSON.stringify(notice)));
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
 * 誰も繋いでこなかったときに畳むまで (ms)。
 *
 * **画面はすぐ来る** — 実測で、ページを組みはじめてから WebSocket が繋がる
 * まで 160ms。それでも来ないなら開いたそばから離れた人なので、掴んだままに
 * しない (ライブは録画の次に強いので、放っておくと番組表集めを蹴り続ける)。
 */
const WARM_WAIT = 8_000;

/**
 * **画面が繋いでくる前に焼きはじめる。**
 *
 * 開いてから絵が出るまでを実機で割ると ([stream.md](../../../docs/stream.md) §4):
 *
 *     画面が動き出して札を取り、WebSocket が繋がるまで   160ms
 *     ffmpeg の立ち上がり                              530ms
 *     放送の I フレーム待ち                          0〜501ms
 *
 * **前の 160ms は後ろと重ねられる。** これから開くのがどの局かは、画面を
 * 組む時点で分かっている — 番組表から名指しで来たか (`?service=`)、画面が
 * 覚えている前回の局か (`LAST_COOKIE`)、一覧の先頭。
 *
 * **1枚も出ないうちに繋がるので、合流の待ちは付かない。** 焼いたものは
 * 鍵フレームから始まるが、それが出るのは 530ms 後なので、160ms で来る画面は
 * まだ何も渡されていない状態で乗る。
 *
 * 待たない・投げない。掴めなくても画面はいつもどおり繋いでくるので、
 * そのとき改めて開くだけ。
 */
export function warm(channelType: string, channel: string, serviceId: number, audio?: string): void {
    if (channelType === '' || channel === '' || !Number.isFinite(serviceId)) return;

    const now = nowPlaying(serviceId, audio);
    const id = key(channelType, channel, serviceId, now.smooth, now.audio);
    // 既に焼いていれば何もしない。開き直すたびに増やさない
    if (sessions.has(id)) return;

    const session = new Session(channelType, channel, serviceId, now.program, now.smooth, now.audio);
    sessions.set(id, session);
    void session.run();

    /*
     * **誰も来なければ自分で畳む。** 見ている人が居なくなったら畳む仕掛け
     * (`attend` の `leave`) は、**1人も来なかった場合には動かない**
     */
    const timer = setTimeout(() => {
        if (session.empty) session.stop();
    }, WARM_WAIT);
    timer.unref?.();
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
    const followCaptions = (
        channelType: string,
        channel: string,
        serviceId: number,
        program: number,
        track: number,
    ) => {
        const id = `${channelType}:${channel}:${serviceId}:${track}`;
        if (id === captionKey) return;
        dropCaptions?.();
        captionKey = id;
        const tell = (notice: Notice) =>
            connection.send(CHANNEL.control, 0n, new TextEncoder().encode(JSON.stringify(notice)));
        dropCaptions = watchCaptions(
            channelType,
            channel,
            serviceId,
            program,
            track,
            (caption) => {
                const { kind, pts, data } = frame(caption);
                connection.send(kind, pts, data);
            },
            // 選べる字幕。**1枚も届いていなくても分かる** (入口の見出しに出ている)
            (tracks) => tell({ type: 'captions', tracks, track }),
        );
    };

    connection.onmessage = (message) => {
        if (message.type !== 'tune') return;
        const channelType = typeof message.channelType === 'string' ? message.channelType : '';
        const channel = typeof message.channel === 'string' ? message.channel : '';
        const serviceId = Number(message.serviceId);
        const audio = typeof message.audio === 'string' ? message.audio : undefined;
        // 字幕は映像とは別の ffmpeg なので、選び直しても映像は焼き直しにならない
        const caption = Number.isInteger(message.caption) ? Math.max(0, Number(message.caption)) : 0;
        if (channelType === '' || channel === '') return;

        const now = nowPlaying(serviceId, audio);

        /*
         * **物理チャンネルが変わるなら、前のを先に離す。**
         *
         * 字幕は映像とは別に TS をもう1本もらう (`captions.ts`)。前のチャンネルを
         * 掴んだまま新しいチャンネルの字幕を頼むと、**その一瞬だけチューナーが
         * 1本余分に要る** — 地上波は2本しかないので、番組表集めが1本使っていると
         * そこで断られる (実機で `[captions] GR:T15: チューナーに空きがありません`)。
         *
         * 離すのは物理チャンネルが変わるときだけ。同じチャンネルの中で局や音声を
         * 選び直すぶんには、エージェント側で相乗りになるので余分は要らない
         */
        if (current !== null && (current.channelType !== channelType || current.channel !== channel)) {
            leave();
        }

        /*
         * **字幕は映像より先に面倒をみる。** 映像とは別建てなので、焼き方が同じでも
         * (=下の早戻りに掛かっても) 字幕だけ選び直せる。局が同じなら
         * `followCaptions` の中で何もしない
         */
        followCaptions(channelType, channel, serviceId, now.program, caption);

        /*
         * **同じものを焼いているなら、そのまま。**
         *
         * ただし**畳まれていないことを確かめる** — ffmpeg が降りたセッションを
         * 指したままだと「もう見ている」と見なされ、選び直しても「やり直す」を
         * 押しても新しく起こさない。画面は待ち続けるだけになる
         */
        if (
            current?.alive === true &&
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
