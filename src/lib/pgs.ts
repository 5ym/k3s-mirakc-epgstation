/**
 * PGS (Blu-ray の字幕) を組み立てる。
 *
 * **なぜ自分で書くのか。** ARIB字幕は放送に絵が乗っているわけではなく、
 * 文字と「どこに・どの大きさで・何色で・背景の箱つきで」という指定が流れてくる。
 * テレビはそれを見て毎回自分で描いている。denpa も libaribcaption に同じように
 * 描かせて絵にできるのだが、**その絵を入れられる入れ物が無い**。
 *
 * - ffmpeg が作れるビットマップ字幕は dvdsub / dvbsub / xsub の3つだけで、
 *   PGS の符号器は無い (復号だけ)
 * - dvdsub は1枚4色まで。放送どおりに描いた字幕は実測で230色 (縁のなめらかさと
 *   話者ごとの色分け) なので、文字・縁・箱・透明で使い切ってしまう
 * - PGS は1枚256色 + 画素ごとの透明度なので、描いたままがそのまま入る
 *
 * ffmpeg は `.sup` を**読む**ことはできる (sup デマクサ + hdmv_pgs_subtitle)。
 * つまり denpa が `.sup` を書ければ、あとは入力の1つとして渡して `-c:s copy`
 * するだけで mkv に入る。道具を増やさずに済むので、そうしている。
 *
 * 形式は Blu-ray の仕様どおり。1つの節 (segment) は
 *   'PG' / PTS(90kHz) / DTS / 種類 / 長さ / 中身
 * で、字幕1枚ぶんが PCS・WDS・PDS・ODS・END の並び (display set) になる。
 */

/** 節の種類 */
const SEGMENT_PDS = 0x14;
const SEGMENT_ODS = 0x15;
const SEGMENT_PCS = 0x16;
const SEGMENT_WDS = 0x17;
const SEGMENT_END = 0x80;

/** PGS の時刻は 90kHz 刻み */
const CLOCK = 90_000;
/** 1節に入る中身の上限。超えるぶんは ODS を分ける */
const MAX_SEGMENT = 0xffff;
/** パレットは256色。0番を透明に使うので、絵に使えるのは255色 */
const MAX_COLORS = 255;
/**
 * 透明を表す番号。
 *
 * **0番でなければならない。** 走り書きは「0番が何個続くか」だけ色を書かずに
 * 詰められる形を持っていて、字幕の絵はほとんどが透明なので、ここを 0番にするかどうかで
 * 大きさが桁で変わる
 */
const TRANSPARENT = 0;

export interface Bitmap {
    width: number;
    height: number;
    /** RGBA が画素ぶん並んだもの */
    data: Uint8Array;
}

/** 字幕1枚。いつ出していつ消すか */
export interface Caption {
    /** 出す時刻 (秒) */
    start: number;
    /** 消す時刻 (秒) */
    end: number;
    bitmap: Bitmap;
}

export interface Cropped {
    x: number;
    y: number;
    width: number;
    height: number;
    /** RGBA。切り抜いた範囲ぶん */
    data: Uint8Array;
}

/**
 * 透明でないところだけを切り出す。
 *
 * 描いた絵は画面まるごと (1440x1080) の大きさで返ってくるが、字幕が載っているのは
 * たいてい下の数行ぶん。まるごと入れると再生側の復号が間に合わない
 * (PGS は1秒あたりに送れる量が決まっている)。
 */
export function crop(bitmap: Bitmap): Cropped | null {
    const { width, height, data } = bitmap;
    let top = height;
    let left = width;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] === 0) continue;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
        }
    }
    if (bottom < 0) return null;

    const w = right - left + 1;
    const h = bottom - top + 1;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const from = ((top + y) * width + left) * 4;
        out.set(data.subarray(from, from + w * 4), y * w * 4);
    }
    return { x: left, y: top, width: w, height: h, data: out };
}

export interface Palette {
    /** 色番号 → YCrCbA */
    entries: Uint8Array;
    /** 画素ごとの色番号 */
    indices: Uint8Array;
}

/**
 * PGS のパレットは YCrCb (限定レンジ) で持つ。**読む側の戻し方に合わせる。**
 *
 * ffmpeg の pgssubdec は「高さが 576 より大きい / 分からないときは BT.709、
 * それ以下なら BT.601」で戻す。こちらもその通りに書き分ける。
 * 全レンジ (JPEG) の係数で書いていた頃は色が13%濃くなり、BT.601 で書いていた頃は
 * 暗い緑が16%暗くなっていた (実測: 1080 の字幕で最大39のずれ)。
 */
export function isBt709(height: number): boolean {
    return height <= 0 || height > 576;
}

function toYCrCb(r: number, g: number, b: number, bt709: boolean): [number, number, number] {
    // 係数は読む側 (YUV_TO_RGB1_CCIR / _BT709) の裏返し。224/255 ÷ 各係数
    const y = bt709 ? 0.2126 * r + 0.7152 * g + 0.0722 * b : 0.299 * r + 0.587 * g + 0.114 * b;
    const toCb = bt709 ? 0.473_39 : 0.495_73;
    const toCr = bt709 ? 0.557_8 : 0.626_56;
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    return [clamp(16 + (y * 219) / 255), clamp((r - y) * toCr + 128), clamp((b - y) * toCb + 128)];
}

/**
 * 色に番号を振る。
 *
 * 実測では1枚230色ほどなので、たいていはそのまま入る。溢れたときは
 * よく使われている色から255色を採り、残りはいちばん近い色に寄せる
 * (縁のなめらかさが少し粗くなるだけで、文字は読める)。
 */
export function quantize(pixels: Uint8Array, bt709 = true): Palette {
    const count = new Map<number, number>();
    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] === 0) continue;
        const key = ((pixels[i] << 24) | (pixels[i + 1] << 16) | (pixels[i + 2] << 8) | pixels[i + 3]) >>> 0;
        count.set(key, (count.get(key) ?? 0) + 1);
    }

    const chosen = [...count.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_COLORS)
        .map(([key]) => key);

    // 0番は透明のまま空けておく。絵に使う色は1番から
    const index = new Map<number, number>();
    const entries = new Uint8Array(256 * 4);
    chosen.forEach((key, i) => {
        const slot = i + 1;
        const r = (key >>> 24) & 0xff;
        const g = (key >>> 16) & 0xff;
        const b = (key >>> 8) & 0xff;
        const a = key & 0xff;
        const [y, cr, cb] = toYCrCb(r, g, b, bt709);
        entries[slot * 4] = y;
        entries[slot * 4 + 1] = cr;
        entries[slot * 4 + 2] = cb;
        entries[slot * 4 + 3] = a;
        index.set(key, slot);
    });

    const nearest = (key: number): number => {
        const r = (key >>> 24) & 0xff;
        const g = (key >>> 16) & 0xff;
        const b = (key >>> 8) & 0xff;
        const a = key & 0xff;
        let best = TRANSPARENT;
        let distance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < chosen.length; i++) {
            const other = chosen[i];
            const dr = r - ((other >>> 24) & 0xff);
            const dg = g - ((other >>> 16) & 0xff);
            const db = b - ((other >>> 8) & 0xff);
            const da = a - (other & 0xff);
            const d = dr * dr + dg * dg + db * db + da * da;
            if (d < distance) {
                distance = d;
                best = i + 1;
            }
        }
        return best;
    };

    const indices = new Uint8Array(pixels.length / 4);
    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
        if (pixels[i + 3] === 0) {
            indices[p] = TRANSPARENT;
            continue;
        }
        const key = ((pixels[i] << 24) | (pixels[i + 1] << 16) | (pixels[i + 2] << 8) | pixels[i + 3]) >>> 0;
        const found = index.get(key);
        if (found !== undefined) {
            indices[p] = found;
            continue;
        }
        const near = nearest(key);
        index.set(key, near);
        indices[p] = near;
    }
    return { entries, indices };
}

/**
 * 走り書き (RLE) にする。行ごとに「同じ色が何画素続くか」で詰める。
 *
 *   1画素          … 色をそのまま1バイト (0番以外)
 *   0番が L 個     … 00 / 00LLLLLL          (L < 64)
 *   0番が L 個     … 00 / 01LLLLLL LLLLLLLL (L < 16384)
 *   色 C が L 個   … 00 / 10LLLLLL C        (3 <= L < 64)
 *   色 C が L 個   … 00 / 11LLLLLL LLLLLLLL C
 *   行の終わり     … 00 00
 */
export function rle(indices: Uint8Array, width: number, height: number): Uint8Array {
    const out: number[] = [];
    for (let y = 0; y < height; y++) {
        let x = 0;
        while (x < width) {
            const color = indices[y * width + x];
            let run = 1;
            while (x + run < width && indices[y * width + x + run] === color) run++;
            x += run;

            if (color === 0) {
                // 0番だけは「色を書かない」短い形が使える
                while (run > 0) {
                    const take = Math.min(run, 16383);
                    if (take < 64) out.push(0x00, take);
                    else out.push(0x00, 0x40 | (take >> 8), take & 0xff);
                    run -= take;
                }
                continue;
            }
            while (run > 0) {
                const take = Math.min(run, 16383);
                if (take <= 2) {
                    for (let i = 0; i < take; i++) out.push(color);
                } else if (take < 64) {
                    out.push(0x00, 0x80 | take, color);
                } else {
                    out.push(0x00, 0xc0 | (take >> 8), take & 0xff, color);
                }
                run -= take;
            }
        }
        out.push(0x00, 0x00);
    }
    return Uint8Array.from(out);
}

function segment(type: number, pts: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(13 + payload.length);
    const view = new DataView(out.buffer);
    out[0] = 0x50; // 'P'
    out[1] = 0x47; // 'G'
    view.setUint32(2, Math.max(0, Math.round(pts * CLOCK)) >>> 0);
    view.setUint32(6, 0); // DTS は使わない
    out[10] = type;
    view.setUint16(11, payload.length);
    out.set(payload, 13);
    return out;
}

/** 画面の構成 (どの絵をどこに出すか)。中身が無いものは「消す」の意味になる */
function pcs(
    videoWidth: number,
    videoHeight: number,
    composition: number,
    object: { x: number; y: number } | null,
): Uint8Array {
    const out = new Uint8Array(object === null ? 11 : 19);
    const view = new DataView(out.buffer);
    view.setUint16(0, videoWidth);
    view.setUint16(2, videoHeight);
    out[4] = 0x10; // フレームレート。仕様上ここは固定値
    view.setUint16(5, composition & 0xffff);
    out[7] = object === null ? 0x00 : 0x80; // 0x80 = ここから新しい場面
    out[8] = 0x00; // パレットだけの差し替えではない
    out[9] = 0x00; // パレット番号
    out[10] = object === null ? 0 : 1;
    if (object !== null) {
        view.setUint16(11, 0); // 絵の番号
        out[13] = 0; // 窓の番号
        out[14] = 0; // 切り抜きなし
        view.setUint16(15, object.x);
        view.setUint16(17, object.y);
    }
    return out;
}

/** 絵を置く窓 */
function wds(x: number, y: number, width: number, height: number): Uint8Array {
    const out = new Uint8Array(10);
    const view = new DataView(out.buffer);
    out[0] = 1; // 窓は1つ
    out[1] = 0; // 窓の番号
    view.setUint16(2, x);
    view.setUint16(4, y);
    view.setUint16(6, width);
    view.setUint16(8, height);
    return out;
}

/** 色の表 */
function pds(entries: Uint8Array): Uint8Array {
    const out = new Uint8Array(2 + 256 * 5);
    out[0] = 0; // パレット番号
    out[1] = 0; // 版
    for (let i = 0; i < 256; i++) {
        out[2 + i * 5] = i;
        out[2 + i * 5 + 1] = entries[i * 4];
        out[2 + i * 5 + 2] = entries[i * 4 + 1];
        out[2 + i * 5 + 3] = entries[i * 4 + 2];
        out[2 + i * 5 + 4] = entries[i * 4 + 3];
    }
    return out;
}

/**
 * 絵そのもの。長いと1節に収まらないので分ける。
 * 先頭には「これから何バイト来るか」と大きさが付く (最初の節にだけ)。
 */
function odsSegments(pts: number, width: number, height: number, data: Uint8Array): Uint8Array[] {
    const head = new Uint8Array(11);
    const view = new DataView(head.buffer);
    view.setUint16(0, 0); // 絵の番号
    head[2] = 0; // 版
    head[3] = 0xc0; // 最初で最後 (下で入れ替える)
    const length = data.length + 4;
    head[4] = (length >> 16) & 0xff;
    head[5] = (length >> 8) & 0xff;
    head[6] = length & 0xff;
    view.setUint16(7, width);
    view.setUint16(9, height);

    const first = MAX_SEGMENT - head.length;
    if (data.length <= first) {
        const payload = new Uint8Array(head.length + data.length);
        payload.set(head, 0);
        payload.set(data, head.length);
        return [segment(SEGMENT_ODS, pts, payload)];
    }

    const segments: Uint8Array[] = [];
    head[3] = 0x80; // 最初
    const payload = new Uint8Array(head.length + first);
    payload.set(head, 0);
    payload.set(data.subarray(0, first), head.length);
    segments.push(segment(SEGMENT_ODS, pts, payload));

    let at = first;
    while (at < data.length) {
        const take = Math.min(MAX_SEGMENT - 4, data.length - at);
        const rest = new Uint8Array(4 + take);
        new DataView(rest.buffer).setUint16(0, 0);
        rest[2] = 0;
        rest[3] = at + take >= data.length ? 0x40 : 0x00; // 最後 / 途中
        rest.set(data.subarray(at, at + take), 4);
        segments.push(segment(SEGMENT_ODS, pts, rest));
        at += take;
    }
    return segments;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/**
 * 字幕を1枚ずつ足していって .sup にする。
 *
 * 1枚ごとに「出す」と「消す」の2組を書く。消し忘れると次の字幕が出るまで
 * 画面に残るので、終わりの時刻でかならず空の構成を入れる。
 *
 * **絵を溜め込まない形にしてある。** 描いた絵は画面まるごとの RGBA (1440x1080 なら
 * 1枚 6MB) なので、番組ぶん抱えると持ちきれない。足された時点で走り書きに直して、
 * 出来上がった節だけを持つ (1枚あたり数十KB)。
 */
export class SupWriter {
    private readonly parts: Uint8Array[] = [];
    private composition = 0;
    /** 入れた字幕の枚数。中身の無い絵は数えない */
    captions = 0;

    add(bitmap: Bitmap, start: number, end: number): void {
        const box = crop(bitmap);
        if (box === null) return;
        const { width: videoWidth, height: videoHeight } = bitmap;
        const { entries, indices } = quantize(box.data, isBt709(videoHeight));
        const data = rle(indices, box.width, box.height);

        this.parts.push(
            segment(SEGMENT_PCS, start, pcs(videoWidth, videoHeight, this.composition++, box)),
            segment(SEGMENT_WDS, start, wds(box.x, box.y, box.width, box.height)),
            segment(SEGMENT_PDS, start, pds(entries)),
            ...odsSegments(start, box.width, box.height, data),
            segment(SEGMENT_END, start, new Uint8Array(0)),
            segment(SEGMENT_PCS, end, pcs(videoWidth, videoHeight, this.composition++, null)),
            segment(SEGMENT_WDS, end, wds(box.x, box.y, box.width, box.height)),
            segment(SEGMENT_END, end, new Uint8Array(0)),
        );
        this.captions++;
    }

    bytes(): Uint8Array {
        return concat(this.parts);
    }
}

/** 並べて渡す形。試験と、短いものを一度に作るとき用 */
export function writeSup(captions: Caption[]): Uint8Array {
    const writer = new SupWriter();
    for (const caption of captions) writer.add(caption.bitmap, caption.start, caption.end);
    return writer.bytes();
}
