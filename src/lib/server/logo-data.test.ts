import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * logoframe が覚えたロゴ (`.lgd`) の読み取り。
 *
 * 覚えているものが絵になっていないことがあり、それを確かめる手立てが無いと
 * 「なぜ当たらないのか」が分からない。実機の TOKYO MX は 48×158 の縦長の帯を
 * 覚えていて、中身は横縞の雑音、濃さも 268/1000 止まりだった。
 */
const { config } = await import('./config');
config.jlsLogoDir = mkdtempSync(join(tmpdir(), 'denpa-lgd-'));

const { forgetLogoData, logoRepo, readLearnedLogo } = await import('./logo-data');

const HEADER = 80;
const PIXEL = 12;

/** 本物と同じ並びの `.lgd` を組む */
function write(serviceId: number, box: { x: number; y: number; w: number; h: number }, depths: number[]) {
    const bytes = new Uint8Array(HEADER + box.w * box.h * PIXEL);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('<logo data file ver0.1>'), 0);
    view.setUint32(28, 1);
    bytes.set(new TextEncoder().encode('TEST'), 32);
    view.setInt16(64, box.x, true);
    view.setInt16(66, box.y, true);
    view.setInt16(68, box.w, true);
    view.setInt16(70, box.h, true);
    for (let i = 0; i < box.w * box.h; i++) {
        view.setInt16(HEADER + i * PIXEL, depths[i] ?? 0, true);
    }
    const dir = logoRepo(serviceId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'TEST-v0001.lgd'), bytes);
    return dir;
}

describe('readLearnedLogo', () => {
    test('覚えている枠と濃さを読み、白黒のPNGにする', () => {
        // 濃さは 0〜1000 の尺度。負の値も入る (実機で -63 まで見た)
        write(1, { x: 1226, y: 58, w: 2, h: 2 }, [1000, 500, 0, -63]);

        const logo = readLearnedLogo(1);
        expect(logo).not.toBeNull();
        expect(logo).toMatchObject({ name: 'TEST', x: 1226, y: 58, width: 2, height: 2, depth: 1000 });

        // PNG の署名と IHDR の大きさ。中身までは見ない
        const png = logo!.png;
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
        expect(view.getUint32(16)).toBe(2);
        expect(view.getUint32(20)).toBe(2);
    });

    test('いちばん濃いところを返す。薄いものはロゴではない何かを覚えている', () => {
        write(2, { x: 0, y: 0, w: 1, h: 2 }, [268, 100]);
        expect(readLearnedLogo(2)?.depth).toBe(268);
    });

    test('まだ覚えていない局は null', () => {
        expect(readLearnedLogo(999)).toBeNull();
    });

    test('捨てると読めなくなる。位置を教え直したら覚え直させる', () => {
        const dir = write(3, { x: 0, y: 0, w: 1, h: 1 }, [900]);
        expect(existsSync(dir)).toBe(true);

        forgetLogoData(3);

        expect(existsSync(dir)).toBe(false);
        expect(readLearnedLogo(3)).toBeNull();
    });
});
