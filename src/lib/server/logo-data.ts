import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { pngChunk } from '../ts/logo-palette';
import { config } from './config';

/**
 * logoframe が覚えたロゴ (`.lgd`) の置き場と、その中身。
 *
 * **これは放送波から拾う局ロゴ (PNG) とは別物。** あちらは番組表に出すための絵で、
 * こちらは「画面のどこにロゴが出ているか」を録画から学習したもの (`server/logo.ts`)。
 */

/**
 * 覚えたロゴの置き場。**局ごとに分ける。**
 *
 * logoframe は局名をファイル名に埋めて覚えるが、その名前は多バイト文字を
 * `_E7_B7_8F` のように潰したもので、こちらから組み立て直しても当たる保証がない。
 * 局ごとの入れ物にしておけば、位置を教え直したときに丸ごと捨てられる。
 *
 * **捨てられることが要る。** `-logo-area` はロゴを覚えるときにしか効かず、
 * 既に覚えているものがあれば合致率が落ちるまで作り直さない。捨てられないと、
 * 位置を教えても覚えているほうが使われ続ける。
 */
export function logoRepo(serviceId: number | undefined): string {
    return serviceId === undefined ? config.jlsLogoDir : join(config.jlsLogoDir, String(serviceId));
}

/**
 * その局の覚えたロゴを捨てる。次のエンコードで、教えてもらった枠から覚え直す。
 * 覚え直しは録画1本ぶん余計にかかるが、当たらないまま回り続けるよりはいい
 */
export function forgetLogoData(serviceId: number): void {
    rmSync(logoRepo(serviceId), { recursive: true, force: true });
}

/**
 * `.lgd` の中身。
 *
 * ```
 * 0x00 char[28] "<logo data file ver0.1>" + NUL 詰め
 * 0x1C uint32BE 入っているロゴの数 (denpa の使い方では常に1)
 * 0x20 char[32] 局名
 * 0x40 int16LE  x, y, 高さ, 幅, fi, fo, st, ed
 * 0x50 以降     画素ごとに int16LE × 6 (dp_y, y, dp_cb, cb, dp_cr, cr)
 * ```
 *
 * **高さが先。** `-logo-area x,y,w,h` を渡して書かせたものと突き合わせて確かめた
 * (`200,70` を渡すと 0x44 に 70、0x46 に 200 が入る)。逆に読んでいた頃は、
 * 画面に出る枠も絵も転置されていた。
 *
 * 色は使われていない。実機の `.lgd` は cb/cr が全画素 0 で、意味を持つのは
 * **濃さ (dp_y)** だけだった。y は int16 の端まで振り切れていて色にならない。
 */
const HEADER = 80;
const PIXEL = 12;
/** 濃さの満点。logoframe/AviUtl 系のロゴ形式はこの尺度で持つ */
const FULL_DEPTH = 1000;

export interface LearnedLogo {
    /** logoframe が覚えた局名 */
    name: string;
    /** 覚えている枠。**記録されているコマの座標** (地上波のHDなら 1440×1080 の中) */
    x: number;
    y: number;
    width: number;
    height: number;
    /**
     * いちばん濃いところ (0〜1000)。
     *
     * **低い = 駄目、とは限らない。** 半透明の細い文字のロゴ (TOKYO MX) は、
     * ちゃんと写っていても 241 しか出ない。良し悪しは絵を見て決めてもらう
     */
    depth: number;
    /**
     * 濃さを明るさにした白黒の PNG。原寸なので、出すときは拡大する。
     *
     * **いちばん濃いところが白になるように伸ばしてある。** 満点 (1000) を白に
     * していた頃は、薄いものが真っ黒になって「薄い」ことしか分からなかった。
     * 知りたいのは形のほうなので伸ばし、薄さは `depth` の数字で伝える
     */
    png: Uint8Array;
}

/** いちばん新しい `.lgd`。logoframe は作り直すたびに `-vNNNN` を上げていく */
function latest(dir: string): string | null {
    try {
        const files = readdirSync(dir)
            .filter((name) => name.endsWith('.lgd'))
            .sort();
        return files.length === 0 ? null : join(dir, files[files.length - 1]);
    } catch {
        // まだ1本も録っていない局。置き場ごと無い
        return null;
    }
}

export function readLearnedLogo(serviceId: number): LearnedLogo | null {
    const path = latest(logoRepo(serviceId));
    if (path === null) return null;

    let bytes: Uint8Array;
    try {
        bytes = readFileSync(path);
    } catch {
        return null;
    }
    if (bytes.length < HEADER) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const name = new TextDecoder().decode(bytes.subarray(32, 64)).replace(/\0.*$/, '');
    const x = view.getInt16(64, true);
    const y = view.getInt16(66, true);
    const height = view.getInt16(68, true);
    const width = view.getInt16(70, true);
    if (width <= 0 || height <= 0) return null;
    if (bytes.length < HEADER + width * height * PIXEL) return null;

    // 濃さを明るさにする。色は入っていない (cb/cr は全画素 0)
    const depths = new Int16Array(width * height);
    let depth = 0;
    for (let i = 0; i < width * height; i++) {
        depths[i] = view.getInt16(HEADER + i * PIXEL, true);
        depth = Math.max(depth, depths[i]);
    }
    // いちばん濃いところを白にする。満点で割ると、薄いものが真っ黒で形が見えない
    const top = Math.max(1, Math.min(FULL_DEPTH, depth));
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < depths.length; i++) {
        gray[i] = Math.round((Math.max(0, Math.min(top, depths[i])) / top) * 255);
    }

    return { name, x, y, width, height, depth, png: encodeGray(gray, width, height) };
}

/** 8bit グレースケールの PNG。出すのは1枚だけなので、素直に組む */
function encodeGray(gray: Uint8Array, width: number, height: number): Uint8Array {
    const raw = new Uint8Array(height * (1 + width));
    for (let row = 0; row < height; row++) {
        // 各行の頭にフィルタの種類 (0 = なし)
        raw.set(gray.subarray(row * width, (row + 1) * width), row * (1 + width) + 1);
    }
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr[8] = 8; // ビット深度
    ihdr[9] = 0; // 白黒
    const parts = [
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
        pngChunk('IEND', new Uint8Array(0)),
    ];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
