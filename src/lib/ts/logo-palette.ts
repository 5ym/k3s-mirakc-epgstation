/**
 * 放送で流れてくるロゴの PNG に、色の表を入れ直す。
 *
 * ARIB (STD-B21) のロゴは 8bit のパレット PNG なのだが、**パレットそのもの
 * (PLTE/tRNS) は送られてこない。** 色は放送で決め打ちの128色 + 半透明ぶんと
 * 決まっているので、受け取った側がその表を入れて初めて絵になる。
 *
 * 入れないままだと「パレット PNG なのにパレットが無い」壊れたファイルになり、
 * ブラウザは何も描かない。実機では15局ぶん拾えているのに番組表が空のままだった。
 * Mirakurun も同じことをしている (aribts の TsLogo.decode)。
 */

/**
 * 放送で決まっている色の表。R,G,B,A の順に129色ぶん。
 *
 * 前半128色が本体で、最後の1色は全面の半透明。
 * (@chinachu/aribts の lib/logo_clut.js と同じ並び)
 */
// biome-ignore format: 4色ずつの並びのまま置いておきたい
const CLUT = new Uint8Array([
    0, 0, 0, 255,  255, 0, 0, 255,  0, 255, 0, 255,  255, 255, 0, 255,
    0, 0, 255, 255,  255, 0, 255, 255,  0, 255, 255, 255,  255, 255, 255, 255,
    0, 0, 0, 0,  170, 0, 0, 255,  0, 170, 0, 255,  170, 170, 0, 255,
    0, 0, 170, 255,  170, 0, 170, 255,  0, 170, 170, 255,  170, 170, 170, 255,
    0, 0, 85, 255,  0, 85, 0, 255,  0, 85, 85, 255,  0, 85, 170, 255,
    0, 85, 255, 255,  0, 170, 85, 255,  0, 170, 255, 255,  0, 255, 85, 255,
    0, 255, 170, 255,  85, 0, 0, 255,  85, 0, 85, 255,  85, 0, 170, 255,
    85, 0, 255, 255,  85, 85, 0, 255,  85, 85, 85, 255,  85, 85, 170, 255,
    85, 85, 255, 255,  85, 170, 0, 255,  85, 170, 85, 255,  85, 170, 170, 255,
    85, 170, 255, 255,  85, 255, 0, 255,  85, 255, 85, 255,  85, 255, 170, 255,
    85, 255, 255, 255,  170, 0, 85, 255,  170, 0, 255, 255,  170, 85, 0, 255,
    170, 85, 85, 255,  170, 85, 170, 255,  170, 85, 255, 255,  170, 170, 85, 255,
    170, 170, 255, 255,  170, 255, 0, 255,  170, 255, 85, 255,  170, 255, 170, 255,
    170, 255, 255, 255,  255, 0, 85, 255,  255, 0, 255, 255,  255, 85, 0, 255,
    255, 85, 85, 255,  255, 85, 170, 255,  255, 85, 255, 255,  255, 170, 0, 255,
    255, 170, 85, 255,  255, 170, 170, 255,  255, 170, 255, 255,  255, 255, 85, 255,
    255, 255, 255, 255,  0, 0, 0, 128,  255, 0, 0, 128,  0, 255, 0, 128,
    255, 255, 0, 128,  0, 0, 255, 128,  255, 0, 255, 128,  0, 255, 255, 128,
    255, 255, 255, 128,  170, 0, 0, 128,  0, 170, 0, 128,  170, 170, 0, 128,
    0, 0, 170, 128,  170, 0, 170, 128,  0, 170, 170, 128,  170, 170, 170, 128,
    0, 0, 85, 128,  0, 85, 0, 128,  0, 85, 85, 128,  0, 85, 170, 128,
    0, 85, 255, 128,  0, 170, 85, 128,  0, 170, 255, 128,  0, 255, 85, 128,
    0, 255, 170, 128,  85, 0, 0, 128,  85, 0, 85, 128,  85, 0, 170, 128,
    85, 0, 255, 128,  85, 85, 0, 128,  85, 85, 85, 128,  85, 85, 170, 128,
    85, 85, 255, 128,  85, 170, 0, 128,  85, 170, 85, 128,  85, 170, 170, 128,
    85, 170, 255, 128,  85, 255, 0, 128,  85, 255, 85, 128,  85, 255, 170, 128,
    85, 255, 255, 128,  170, 0, 85, 128,  170, 0, 255, 128,  170, 85, 0, 128,
    170, 85, 85, 128,  170, 85, 170, 128,  170, 85, 255, 128,  170, 170, 85, 128,
    170, 170, 255, 128,  170, 255, 0, 128,  170, 255, 85, 128,  170, 255, 170, 128,
    170, 255, 255, 128,  255, 0, 85, 128,  255, 0, 255, 128,  255, 85, 0, 128,
    255, 85, 85, 128,  255, 85, 170, 128,  255, 85, 255, 128,  255, 170, 0, 128,
    255, 170, 85, 128,  255, 170, 170, 128,  255, 170, 255, 128,  255, 255, 85, 128,
    255, 255, 255, 128,
]);

const COLORS = CLUT.length / 4;

/** PNG のかたまりに必要な CRC-32 */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** 長さ + 種類 + 中身 + CRC。PNG のかたまりの形 */
function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

/** 署名(8) + IHDR(25)。パレットはこの直後に入れる */
const AFTER_IHDR = 33;
/** 8bit パレットのPNGだけが対象。IHDR の色の種類 */
const COLOR_TYPE_PALETTE = 3;

function isPaletteImage(png: Uint8Array): boolean {
    if (png.length < AFTER_IHDR + 12) return false;
    if (png[12] !== 0x49 || png[13] !== 0x48 || png[14] !== 0x44 || png[15] !== 0x52) return false; // IHDR
    return png[25] === COLOR_TYPE_PALETTE;
}

function hasPalette(png: Uint8Array): boolean {
    // IHDR の次のかたまりが PLTE かどうか
    return (
        png[AFTER_IHDR + 4] === 0x50 &&
        png[AFTER_IHDR + 5] === 0x4c &&
        png[AFTER_IHDR + 6] === 0x54 &&
        png[AFTER_IHDR + 7] === 0x45
    );
}

/**
 * 放送で決まっている色の表を入れた PNG を返す。
 * すでに入っているもの・形が違うものはそのまま返す (拾い直しの手間を増やさない)。
 */
export function withPalette(png: Uint8Array): Uint8Array {
    if (!isPaletteImage(png) || hasPalette(png)) return png;

    const rgb = new Uint8Array(COLORS * 3);
    const alpha = new Uint8Array(COLORS);
    for (let i = 0; i < COLORS; i++) {
        rgb[i * 3] = CLUT[i * 4];
        rgb[i * 3 + 1] = CLUT[i * 4 + 1];
        rgb[i * 3 + 2] = CLUT[i * 4 + 2];
        alpha[i] = CLUT[i * 4 + 3];
    }

    const plte = chunk('PLTE', rgb);
    const trns = chunk('tRNS', alpha);
    const out = new Uint8Array(png.length + plte.length + trns.length);
    out.set(png.subarray(0, AFTER_IHDR), 0);
    out.set(plte, AFTER_IHDR);
    out.set(trns, AFTER_IHDR + plte.length);
    out.set(png.subarray(AFTER_IHDR), AFTER_IHDR + plte.length + trns.length);
    return out;
}
