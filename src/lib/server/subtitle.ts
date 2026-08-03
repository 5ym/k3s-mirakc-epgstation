import { statSync, writeFileSync } from 'node:fs';
import { SupWriter } from '../pgs';
import { config } from './config';
import { chunks, lines } from './stream';

/**
 * ARIB字幕を絵にして PGS (.sup) にする。
 *
 * 放送に絵が流れてくるわけではない。乗っているのは文字と「どこに・どの大きさで・
 * 何色で・背景の箱つきで」という指定で、テレビはそれを見て毎回自分で描いている。
 * libaribcaption に同じように描かせたものが `-sub_type bitmap` で、
 * **それが「放送どおりの字幕の絵」**になる (外字もここでは絵として出る)。
 *
 * 絵を受け取る口は ffmpeg の sub2video。字幕をフィルタの入力にすると、
 * 1枚ごとに RGBA の映像フレームとして出てくる。時刻は showinfo に喋らせる。
 *
 * 入れる先を PGS にするのは、ffmpeg が作れるビットマップ字幕 (dvdsub/dvbsub/xsub)
 * ではどれも足りないため。dvdsub は1枚4色で、実測230色の字幕は文字・縁・箱で
 * 使い切ってしまう。PGS の符号器は ffmpeg に無いので denpa が書く (src/lib/pgs.ts)。
 */

/** 最後の1枚をどれだけ出しておくか。ふつうは「消す」が来るので使わない */
const TAIL_SECONDS = 5;
/** 絵が1枚も無いのに延々と読み続けない。実時間の数十分の一で終わるはず */
const TIMEOUT = 30 * 60_000;

/** showinfo の1行から時刻と大きさを読む */
const PTS_TIME = /pts_time:\s*(-?[\d.]+)/;
const SIZE = /\ss:(\d+)x(\d+)/;

export interface PgsResult {
    path: string;
    captions: number;
}

/**
 * 字幕を絵で取り出して `.sup` を書く。字幕が無ければ null。
 *
 * 失敗しても録画とエンコードは止めない。**入る字幕はこれ1本だけ**なので、
 * null になった録画には字幕トラックが付かない。
 */
export async function buildPgs(
    input: string,
    canvasSize: string | undefined,
    fonts: string,
    signal?: AbortSignal,
): Promise<PgsResult | null> {
    const output = `${input}.sup`;
    const args = [
        '-hide_banner',
        '-nostats',
        '-y',
        '-sub_type',
        'bitmap',
        ...(canvasSize === undefined ? [] : ['-canvas_size', canvasSize]),
        '-font',
        fonts,
        '-analyzeduration',
        '15000000',
        '-probesize',
        '30000000',
        '-i',
        input,
        // 字幕をフィルタに通すと1枚ずつ映像フレームになる (sub2video)。
        // 時刻と大きさは showinfo が標準エラーに書く
        '-filter_complex',
        '[0:s:0]showinfo[v]',
        '-map',
        '[v]',
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
    ];

    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
    try {
        proc = Bun.spawn([config.ffmpeg, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    } catch {
        return null;
    }
    const kill = () => proc.kill();
    signal?.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, TIMEOUT);

    const writer = new SupWriter();
    /** showinfo が喋った順に溜める。絵の来る順と同じ */
    const stamps: { at: number; width: number; height: number }[] = [];
    let read = 0;

    const readStderr = (async () => {
        for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
            const time = line.match(PTS_TIME);
            const size = line.match(SIZE);
            if (time === null || size === null) continue;
            stamps.push({
                at: Number(time[1]),
                width: Number(size[1]),
                height: Number(size[2]),
            });
        }
    })();

    /*
     * 1枚ぶん溜まるたびに取り出す。**手元に置くのは1枚だけ**にする。
     * 終わりの時刻は次の枚が来て初めて決まるので前の1枚は持っておくが、
     * 全部溜めると 6MB × 枚数になり、長い番組で持ちきれない
     */
    const held: { frame: { data: Uint8Array; at: number } | null } = { frame: null };
    /*
     * 届いた切れ端はそのまま並べておき、1枚ぶん貯まったところで初めて繋ぐ。
     * 届くたびに繋ぎ直すと、1枚 6MB に対して切れ端が 64KB なので、
     * 1枚あたり数百MB ぶんの写し替えになる
     */
    const queue: Uint8Array[] = [];
    let queued = 0;
    let frame = 0;

    /** 先頭から size バイトだけ取り出す */
    const take = (size: number): Uint8Array => {
        const out = new Uint8Array(size);
        let at = 0;
        while (at < size) {
            const part = queue[0];
            const need = size - at;
            if (part.length <= need) {
                out.set(part, at);
                at += part.length;
                queue.shift();
                continue;
            }
            out.set(part.subarray(0, need), at);
            queue[0] = part.subarray(need);
            at += need;
        }
        queued -= size;
        return out;
    };

    const push = (chunk: Uint8Array) => {
        queue.push(chunk);
        queued += chunk.length;

        for (;;) {
            const stamp = stamps[frame];
            if (stamp === undefined) return;
            const size = stamp.width * stamp.height * 4;
            if (queued < size) return;

            const data = take(size);
            frame++;
            const previous = held.frame;
            if (previous !== null) {
                writer.add(
                    { width: stamp.width, height: stamp.height, data: previous.data },
                    previous.at,
                    stamp.at,
                );
            }
            held.frame = { data, at: stamp.at };
        }
    };

    try {
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            read += chunk.length;
            push(chunk);
        }
        await readStderr;
        await proc.exited;
        /*
         * 時刻が絵より遅れて届くことがある (別々の口から来るため)。
         * 最後にもう一度だけ突き合わせて、取りこぼした枚を拾う
         */
        push(new Uint8Array(0));
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
    }

    const last = stamps[frame - 1];
    const tail = held.frame;
    if (tail !== null && last !== undefined) {
        writer.add(
            { width: last.width, height: last.height, data: tail.data },
            tail.at,
            tail.at + TAIL_SECONDS,
        );
    }

    if (writer.captions === 0) {
        // 字幕の無い番組。読めた量だけ残しておくと、後から原因を追える
        if (read > 0) console.log(`[subtitle] 絵になる字幕がありませんでした (${input})`);
        return null;
    }

    try {
        writeFileSync(output, writer.bytes());
        statSync(output);
    } catch (error) {
        console.error(`[subtitle] .sup を書けませんでした: ${error}`);
        return null;
    }
    return { path: output, captions: writer.captions };
}
