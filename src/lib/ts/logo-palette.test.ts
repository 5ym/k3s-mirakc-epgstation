import { describe, expect, test } from 'bun:test';
import { withPalette } from './logo-palette';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 署名 + IHDR + IDAT + IEND だけの PNG。放送から来るのはこの形 (PLTE が無い) */
function png(colorType: number): Uint8Array {
    const ihdr = [
        0x00,
        0x00,
        0x00,
        0x0d,
        0x49,
        0x48,
        0x44,
        0x52, // IHDR
        0x00,
        0x00,
        0x00,
        0x30, // width 48
        0x00,
        0x00,
        0x00,
        0x18, // height 24
        0x08, // bit depth
        colorType,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00, // CRC (中身は見ない)
    ];
    const idat = [0x00, 0x00, 0x00, 0x01, 0x49, 0x44, 0x41, 0x54, 0x78, 0x00, 0x00, 0x00, 0x00];
    const iend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
    return Uint8Array.from([...SIGNATURE, ...ihdr, ...idat, ...iend]);
}

function chunkTypeAt(data: Uint8Array, at: number): string {
    return String.fromCharCode(...data.subarray(at + 4, at + 8));
}

function lengthAt(data: Uint8Array, at: number): number {
    return new DataView(data.buffer, data.byteOffset).getUint32(at);
}

describe('ロゴの色の表', () => {
    test('IHDR の直後に PLTE と tRNS を入れる', () => {
        const out = withPalette(png(3));
        // 129色ぶん。RGB が 3バイト、透明度が 1バイト
        expect(lengthAt(out, 33)).toBe(129 * 3);
        expect(chunkTypeAt(out, 33)).toBe('PLTE');
        expect(lengthAt(out, 33 + 12 + 129 * 3)).toBe(129);
        expect(chunkTypeAt(out, 33 + 12 + 129 * 3)).toBe('tRNS');
        // 元の中身はそのまま後ろに続く
        expect(chunkTypeAt(out, 33 + 12 + 129 * 3 + 12 + 129)).toBe('IDAT');
    });

    test('CRC は PNG として通る値になっている', () => {
        // ここが違うとブラウザはかたまりごと読み飛ばす。値は実装と別に出したもの
        const out = withPalette(png(3));
        const view = new DataView(out.buffer, out.byteOffset);
        expect(view.getUint32(33 + 8 + 129 * 3).toString(16)).toBe('6dd277b');
        expect(view.getUint32(33 + 12 + 129 * 3 + 8 + 129).toString(16)).toBe('7b70f76f');
    });

    test('もう入っているものはそのまま返す', () => {
        const once = withPalette(png(3));
        expect(withPalette(once)).toBe(once);
    });

    test('パレットを使わない PNG には触らない', () => {
        // 色の表が要るのは 8bit パレット (color type 3) のときだけ
        const truecolor = png(2);
        expect(withPalette(truecolor)).toBe(truecolor);
    });

    test('PNG でないものはそのまま返す', () => {
        const broken = Uint8Array.from([0x89, 0x50]);
        expect(withPalette(broken)).toBe(broken);
    });
});
