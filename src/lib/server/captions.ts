/**
 * ライブ視聴の字幕。**絵にして、変わったときだけ配る。**
 *
 *     エージェント (MPEG-TS) → ffmpeg (sub2video → PNG) → 割る → WebSocket → canvas
 *
 * [stream.md](../../../docs/stream.md) §5.2 にあたる第2段階。放送に絵は流れて
 * こない — 乗っているのは文字と「どこに・どの大きさで・何色で・背景の箱つきで」
 * という指定で、テレビはそれを見て毎回自分で描いている。libaribcaption に同じように
 * 描かせたものが `-sub_type bitmap` で、**それが「放送どおりの字幕の絵」**になる。
 * 外字もここでは絵として出るので、対応表の取りこぼしが起きない。
 *
 * 描画系を録画と共通にしてあるので、**録画で見たものとライブで見たものが同じ絵**に
 * なる。ブラウザ側で B24 を解く道 (aribb24.js) を採らなかったのはこれが理由
 * (stream.md §6)。
 *
 * ## PNG は ffmpeg に組ませる
 *
 * 設計では生の RGBA を受け取って、denpa が切り抜き・256色化・パレット PNG の
 * 組み立てまでやることにしていた。**実機で測ったら、ffmpeg に PNG まで
 * 畳ませるほうが速かった。** 同じ TS 30秒ぶんを通したときの実測:
 *
 *     生の RGBA   1.94秒   406 MB    1枚 8.29 MB
 *     PNG         1.05秒   1.76 MB   1枚 36 KB    ← これ
 *     256色 PNG   4.30秒   0.94 MB   1枚 19 KB
 *
 * **生のほうが遅いのは、書く量が桁違いだから** (毎秒 13MB をパイプに流す)。
 * 256色に落とせば半分になるが、そのために CPU を4倍払うことになる。
 * denpa 側の切り抜き・色数落とし・PNG 組み立ては、まるごと要らなくなった。
 *
 * ## 変わったときだけ送る
 *
 * sub2video は**同じ絵を何度も出す**。実機で数えると毎分98枚出てくるが、
 * **中身が変わっているのは18回だけ**だった (残り8割は出し直し)。そのまま流すと
 * 毎秒 57KB、変わったときだけなら毎秒 8.3KB。宅外から見ることを考えると、
 * ここは落とす価値がある。
 *
 * 中身が空 (全部透明) の枚は「消す」に置き換える。**空かどうかは showinfo に
 * 喋らせる** — `mean:` の最後がアルファの平均で、0 なら1画素も描かれていない。
 * PNG を解いて確かめる必要が無い。
 *
 * ## 局ごとに1本。**音声の選び方では分けない**
 *
 * 字幕は局で決まるので、同じ局を見ている人は音声が違っても同じものを見る。
 * 焼き方 (`live.ts` の目印) にはコマ数と音声が入っているが、こちらは
 * **局までで足りる**。音声を選び直しても字幕は途切れない。
 */

import { CHANNEL } from '$lib/live';
import { config } from './config';
import { chunks, lines } from './stream';
import { openChannelStream } from './tuner';

/**
 * 字幕を描く画面の大きさ。
 *
 * **指定は要る。** 無いと libaribcaption は 1440x1080 (PROFILE_A) とみなすので、
 * 1920x1080 の放送では字幕だけ横に伸びる。受け側は映像の枠に合わせて伸ばすだけ
 * なので、放送が 1440x1080 でもここを 1920x1080 にしておけば辻褄が合う
 * (どちらも表示は 16:9)。
 */
export const CANVAS = { width: 1920, height: 1080 };

/** 字幕に使う字。録画と同じものを使う (見た目を揃えるため) */
const FONTS = 'Rounded M+ 1m for ARIB';

/** showinfo の1行から読むもの */
const PTS_TIME = /pts_time:\s*(-?[\d.]+)/;
const MEAN = /mean:\[([\d\s]+)\]/;

/** PNG の署名。塊の切れ目を見つけるのに使う */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/**
 * 字幕を絵で取り出す ffmpeg の引数。
 *
 * - `-copyts` … **元TSの時刻をそのまま持つ。** 映像側も同じにしてあるので、
 *   受け側は届いた時刻と再生位置をそのまま比べられる。付けないと ffmpeg は
 *   字幕1枚目を 0 秒として数え直す (フィルタに入れるのが字幕1本だけで、
 *   数え直す基準になる映像がこちら側に無いため)
 * - `-sub_type bitmap` … 文字ではなく絵で受け取る。描くのは libaribcaption
 * - `-canvas_size` … 上の説明。無いと 1440x1080 とみなされる
 * - `showinfo` … 時刻と、空かどうか (`mean:`) を標準エラーに喋らせる
 * - `-fps_mode passthrough` … 出てきた枚をそのまま出す。詰め直させない
 * - `image2pipe` + `png` … **PNG まで ffmpeg に組ませる** (上の説明)
 *
 * @param program 放送が名乗っている番号 (`live.ts` の `NowPlaying.program`)。
 *   0以下なら最初に見つけた字幕
 */
export function captionArgs(program: number): string[] {
    const from = Number.isFinite(program) && program > 0 ? `0:p:${program}:s:0` : '0:s:0';
    return [
        '-hide_banner',
        '-nostats',
        '-loglevel',
        'error',
        '-copyts',
        '-sub_type',
        'bitmap',
        '-canvas_size',
        `${CANVAS.width}x${CANVAS.height}`,
        '-font',
        FONTS,
        '-fflags',
        'nobuffer',
        // 映像側と同じ。これ以上小さくしても立ち上がりは縮まない (live.ts)
        '-probesize',
        '400000',
        '-i',
        'pipe:0',
        // 字幕をフィルタに通すと1枚ずつ映像フレームになる (sub2video)
        '-filter_complex',
        `[${from}]showinfo[v]`,
        '-map',
        '[v]',
        '-fps_mode',
        'passthrough',
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        '-pix_fmt',
        'rgba',
        'pipe:1',
    ];
}

/** 字幕1枚。`data` が null なら「消す」 */
export interface Caption {
    /** 放送の時刻 (秒)。映像の再生位置と同じ物差し (`-copyts`) */
    at: number;
    /** パレットではない RGBA の PNG。画面まるごとの大きさ */
    data: Uint8Array | null;
}

export type CaptionListener = (caption: Caption) => void;

/**
 * showinfo が喋った1行を読む。**字幕の行でなければ null。**
 *
 * `mean:` は面ごとの平均で、rgba なら最後がアルファ。0 は1画素も描かれて
 * いないということなので、その枚は「消す」に置き換える
 */
export function readInfo(line: string): { at: number; blank: boolean } | null {
    const time = line.match(PTS_TIME);
    if (time === null) return null;
    const at = Number(time[1]);
    if (!Number.isFinite(at)) return null;
    const mean = line.match(MEAN);
    const alpha = mean === null ? null : Number(mean[1].trim().split(/\s+/).at(-1));
    return { at, blank: alpha === 0 };
}

/**
 * 繋がったバイト列から PNG を1枚ずつ取り出す。
 *
 * 署名で切る。**次の署名が来るまで1枚は完成しない**ので、最後の1枚は
 * 持ち越す (`flush` で取り出す)。IEND を探して切る手もあるが、
 * 署名のほうが1つの決まりで済む。
 */
export class PngSplitter {
    private buffer = new Uint8Array(0);
    /** 1枚目の署名を跨いだか。跨ぐまでは切り出すものが無い */
    private started = false;

    feed(chunk: Uint8Array): Uint8Array[] {
        const joined = new Uint8Array(this.buffer.length + chunk.length);
        joined.set(this.buffer);
        joined.set(chunk, this.buffer.length);
        this.buffer = joined;

        const out: Uint8Array[] = [];
        for (;;) {
            const at = this.find(this.started ? 1 : 0);
            if (at < 0) break;
            if (this.started) out.push(this.buffer.slice(0, at));
            this.buffer = this.buffer.slice(at);
            this.started = true;
        }
        return out;
    }

    /** 最後の1枚。**流れが終わったときだけ呼ぶ** */
    flush(): Uint8Array | null {
        if (!this.started || this.buffer.length === 0) return null;
        const out = this.buffer;
        this.buffer = new Uint8Array(0);
        this.started = false;
        return out;
    }

    private find(from: number): number {
        for (let i = from; i + SIGNATURE.length <= this.buffer.length; i++) {
            if (
                this.buffer[i] === SIGNATURE[0] &&
                this.buffer[i + 1] === SIGNATURE[1] &&
                this.buffer[i + 2] === SIGNATURE[2] &&
                this.buffer[i + 3] === SIGNATURE[3]
            ) {
                return i;
            }
        }
        return -1;
    }
}

/**
 * 局1つぶんの字幕。**見ている人が居る間だけ回す。**
 *
 * 焼き方 (`live.ts` の `Session`) とは別に数える。あちらの目印にはコマ数と音声が
 * 入っているが、字幕は局までで決まるため — 音声を選び直しても途切れさせない。
 */
class Captions {
    private readonly listeners = new Set<CaptionListener>();
    private readonly splitter = new PngSplitter();
    private readonly aborter = new AbortController();
    private proc: ReturnType<typeof Bun.spawn> | null = null;
    /** 出てきた順に待たせる時刻。絵は別の口から来るので突き合わせる */
    private readonly stamps: { at: number; blank: boolean }[] = [];
    /**
     * いま出ている1枚。**途中から入ってきた人に真っ先に渡す。**
     *
     * 字幕は次が来るまで出しっぱなしなので、渡さないとその人には
     * 次の字幕まで何も出ない (数十秒あく)
     */
    private showing: Caption | null = null;
    /** 前に配った絵。**同じものを配り直さない** (8割が出し直し) */
    private last: string | null = null;
    private stopped = false;

    constructor(
        readonly channelType: string,
        readonly channel: string,
        readonly serviceId: number,
        readonly program: number,
    ) {}

    get empty(): boolean {
        return this.listeners.size === 0;
    }

    add(listener: CaptionListener): void {
        this.listeners.add(listener);
        if (this.showing !== null) listener(this.showing);
    }

    remove(listener: CaptionListener): void {
        this.listeners.delete(listener);
    }

    async run(): Promise<void> {
        try {
            const stream = await openChannelStream(
                this.channelType,
                this.channel,
                this.aborter.signal,
                `live ${this.channelType}/${this.channel} 字幕`,
                config.priority.live,
            );
            const proc = Bun.spawn([config.ffmpeg, ...captionArgs(this.program)], {
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            this.proc = proc;
            await Promise.all([this.pump(stream, proc), this.drain(proc), this.watch(proc)]);
        } catch (error) {
            /*
             * **字幕が出せなくても映像は止めない。** 字幕の無い番組も、
             * 字幕を出せない環境も普通にあるので、ここで諦めても実害は
             * 「字幕が出ない」だけ
             */
            if (!this.stopped) console.warn(`[captions] ${this.channelType}:${this.channel}: ${error}`);
        } finally {
            this.stop();
        }
    }

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

    /** 出てきた PNG を、showinfo が喋った時刻と突き合わせて配る */
    private async drain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            for (const png of this.splitter.feed(chunk)) this.deliver(png);
        }
        const tail = this.splitter.flush();
        if (tail !== null) this.deliver(tail);
    }

    /** 時刻と空かどうかは標準エラーから来る */
    private async watch(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
        for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
            const info = readInfo(line);
            if (info !== null) {
                this.stamps.push(info);
                continue;
            }
            const text = line.trim();
            if (text !== '') console.warn(`[captions] ${this.channelType}:${this.channel} ffmpeg: ${text}`);
        }
    }

    private deliver(png: Uint8Array): void {
        const stamp = this.stamps.shift();
        if (stamp === undefined) return;

        // 空の枚は「消す」に。PNG を解かずに済ませるために showinfo に喋らせている
        if (stamp.blank) {
            if (this.last === null) return;
            this.last = null;
            this.hand({ at: stamp.at, data: null });
            return;
        }

        /*
         * **同じ絵は配り直さない。** sub2video は同じものを何度も出すので
         * (実機で毎分98枚のうち中身が変わるのは18回)、そのまま流すと
         * 帯域が7倍になる
         */
        const key = Bun.hash(png).toString(36);
        if (key === this.last) return;
        this.last = key;
        this.hand({ at: stamp.at, data: png });
    }

    private hand(caption: Caption): void {
        this.showing = caption;
        for (const listener of this.listeners) listener(caption);
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.aborter.abort();
        this.proc?.kill();
        running.delete(key(this.channelType, this.channel, this.serviceId));
    }
}

const key = (type: string, channel: string, serviceId: number) => `${type}:${channel}:${serviceId}`;
const running = new Map<string, Captions>();

/**
 * 字幕を受け取り始める。**返ってくるのはやめ方。**
 *
 * 同じ局を見ている人が居れば相乗りする。最後の1人が抜けたら ffmpeg を畳む。
 */
export function watchCaptions(
    channelType: string,
    channel: string,
    serviceId: number,
    program: number,
    listener: CaptionListener,
): () => void {
    const id = key(channelType, channel, serviceId);
    let captions = running.get(id);
    if (captions === undefined) {
        captions = new Captions(channelType, channel, serviceId, program);
        running.set(id, captions);
        void captions.run();
    }
    captions.add(listener);

    const held = captions;
    return () => {
        held.remove(listener);
        if (held.empty) held.stop();
    };
}

/**
 * 送る形にする。**頭に置き場所を付ける** (stream.md §5.3)。
 *
 *     [2:x][2:y][2:w][2:h][PNG...]
 *
 * いまは画面まるごとを送るので x,y は 0 だが、**あとで切り抜くようにしても
 * 受け側を変えずに済む**ように持たせてある。
 */
export function frame(caption: Caption): { kind: number; pts: bigint; data: Uint8Array } {
    const pts = BigInt(Math.max(0, Math.round(caption.at * 90000)));
    if (caption.data === null) return { kind: CHANNEL.subtitleClear, pts, data: new Uint8Array(0) };

    const out = new Uint8Array(8 + caption.data.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, 0);
    view.setUint16(2, 0);
    view.setUint16(4, CANVAS.width);
    view.setUint16(6, CANVAS.height);
    out.set(caption.data, 8);
    return { kind: CHANNEL.subtitle, pts, data: out };
}

/** テスト用。掴んだままのものを残さない */
export function stopAllCaptions(): void {
    for (const captions of [...running.values()]) captions.stop();
}
