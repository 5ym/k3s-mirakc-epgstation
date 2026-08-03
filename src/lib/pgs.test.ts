import { describe, expect, test } from 'bun:test';
import { type Bitmap, crop, isBt709, quantize, rle, SupWriter, writeSup } from './pgs';

/** 指定した色で塗った四角を、透明な画面の中に置く */
function bitmap(
    width: number,
    height: number,
    box: { x: number; y: number; w: number; h: number; color: [number, number, number, number] },
): Bitmap {
    const data = new Uint8Array(width * height * 4);
    for (let y = box.y; y < box.y + box.h; y++) {
        for (let x = box.x; x < box.x + box.w; x++) {
            const at = (y * width + x) * 4;
            data.set(box.color, at);
        }
    }
    return { width, height, data };
}

/** .sup を節ごとに分ける。'PG' / PTS / DTS / 種類 / 長さ / 中身 */
function segments(sup: Uint8Array): { type: number; pts: number; payload: Uint8Array }[] {
    const view = new DataView(sup.buffer, sup.byteOffset);
    const out: { type: number; pts: number; payload: Uint8Array }[] = [];
    let at = 0;
    while (at < sup.length) {
        expect(sup[at]).toBe(0x50);
        expect(sup[at + 1]).toBe(0x47);
        const length = view.getUint16(at + 11);
        out.push({
            type: sup[at + 10],
            pts: view.getUint32(at + 2),
            payload: sup.subarray(at + 13, at + 13 + length),
        });
        at += 13 + length;
    }
    return out;
}

describe('切り抜き', () => {
    test('透明でないところだけを取る', () => {
        const box = crop(bitmap(100, 50, { x: 10, y: 20, w: 30, h: 5, color: [255, 0, 0, 255] }));
        expect(box).toEqual(expect.objectContaining({ x: 10, y: 20, width: 30, height: 5 }));
    });

    test('全部透明なら何も無い', () => {
        expect(crop({ width: 4, height: 4, data: new Uint8Array(64) })).toBeNull();
    });
});

describe('色の表', () => {
    test('透明は0番。走り書きが短くなるので譲れない', () => {
        const { entries, indices } = quantize(Uint8Array.from([0, 0, 0, 0, 255, 0, 0, 255]));
        expect(indices[0]).toBe(0);
        expect(entries[3]).toBe(0);
        // 絵に使う色は1番から
        expect(indices[1]).toBe(1);
        expect(entries[1 * 4 + 3]).toBe(255);
    });

    test('読む側の戻し方に合わせて書き分ける', () => {
        // ffmpeg は「高さ576より上 / 分からない」なら BT.709 で戻す。
        // 合わせないと、実測で暗い緑が16%暗くなった
        expect(isBt709(1080)).toBe(true);
        expect(isBt709(0)).toBe(true);
        expect(isBt709(480)).toBe(false);

        const green = Uint8Array.from([0, 255, 0, 255]);
        const bt709 = quantize(green, true).entries.subarray(4, 8);
        const bt601 = quantize(green, false).entries.subarray(4, 8);
        // 同じ緑でも書く値が違う
        expect([...bt709]).not.toEqual([...bt601]);
        // 明るさは BT.709 のほうが緑を重く見る (0.7152 対 0.587)
        expect(bt709[0]).toBeGreaterThan(bt601[0]);
    });

    test('255色を超えたら近い色に寄せる', () => {
        // 1色ずつ違う300色を作る
        const pixels = new Uint8Array(300 * 4);
        for (let i = 0; i < 300; i++) {
            pixels[i * 4] = i % 256;
            pixels[i * 4 + 1] = (i * 7) % 256;
            pixels[i * 4 + 2] = (i * 13) % 256;
            pixels[i * 4 + 3] = 255;
        }
        const { indices } = quantize(pixels);
        // 番号は 1..255 に収まる (0番は透明のまま)
        expect(Math.max(...indices)).toBeLessThanOrEqual(255);
        expect(Math.min(...indices)).toBeGreaterThan(0);
    });
});

describe('走り書き', () => {
    test('透明の並びは色を書かずに詰める', () => {
        // 透明(0番)が10個 → 00 0A、行の終わりに 00 00
        expect([...rle(new Uint8Array(10), 10, 1)]).toEqual([0x00, 0x0a, 0x00, 0x00]);
    });

    test('64個以上は2バイトで長さを書く', () => {
        const out = [...rle(new Uint8Array(100), 100, 1)];
        expect(out).toEqual([0x00, 0x40, 100, 0x00, 0x00]);
    });

    test('色つきの並びは長さと色を書く', () => {
        const line = new Uint8Array(5).fill(3);
        expect([...rle(line, 5, 1)]).toEqual([0x00, 0x80 | 5, 3, 0x00, 0x00]);
    });

    test('1個や2個は色をそのまま並べる', () => {
        // 短いものに長さを付けるとかえって増える
        expect([...rle(Uint8Array.from([7]), 1, 1)]).toEqual([7, 0x00, 0x00]);
        expect([...rle(Uint8Array.from([7, 7]), 2, 1)]).toEqual([7, 7, 0x00, 0x00]);
    });

    test('行ごとに終わりの印が入る', () => {
        const out = rle(new Uint8Array(4), 2, 2);
        expect([...out]).toEqual([0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00]);
    });
});

describe('.sup の組み立て', () => {
    const sample = bitmap(1440, 1080, { x: 100, y: 900, w: 200, h: 40, color: [255, 255, 255, 255] });

    test('出すのと消すので2組。並びは仕様どおり', () => {
        const parts = segments(writeSup([{ start: 0, end: 3, bitmap: sample }]));
        expect(parts.map((p) => p.type)).toEqual([
            0x16, // PCS 画面の構成
            0x17, // WDS 窓
            0x14, // PDS 色の表
            0x15, // ODS 絵
            0x80, // END
            0x16, // PCS (中身なし = 消す)
            0x17,
            0x80,
        ]);
    });

    test('時刻は 90kHz 刻み', () => {
        const parts = segments(writeSup([{ start: 1.5, end: 3, bitmap: sample }]));
        // 先頭の空を挟んだ次から本体
        expect(parts[2].pts).toBe(135_000);
        expect(parts.at(-1)?.pts).toBe(270_000);
    });

    test('0秒から始まらないときは頭に空を置く', () => {
        /*
         * ffmpeg は入力ごとに「いつ始まるか」を引いて繋ぐので、置かないと
         * 字幕全体が前へずれる (実機で1秒ずれた)
         */
        const parts = segments(writeSup([{ start: 1, end: 3, bitmap: sample }]));
        expect(parts[0].pts).toBe(0);
        expect(parts[0].type).toBe(0x16);
        expect(parts[0].payload[10]).toBe(0); // 中身は無い
        expect(parts[1].type).toBe(0x80);

        // 0秒から始まるなら要らない
        expect(segments(writeSup([{ start: 0, end: 3, bitmap: sample }]))[0].payload[10]).toBe(1);
    });

    test('窓は字幕のあるところだけ', () => {
        const parts = segments(writeSup([{ start: 0, end: 1, bitmap: sample }]));
        const wds = parts.find((p) => p.type === 0x17)!;
        const view = new DataView(wds.payload.buffer, wds.payload.byteOffset);
        expect(view.getUint16(2)).toBe(100); // x
        expect(view.getUint16(4)).toBe(900); // y
        expect(view.getUint16(6)).toBe(200); // 幅
        expect(view.getUint16(8)).toBe(40); // 高さ
    });

    test('画面の大きさは絵の大きさから取る', () => {
        const parts = segments(writeSup([{ start: 0, end: 1, bitmap: sample }]));
        const view = new DataView(parts[0].payload.buffer, parts[0].payload.byteOffset);
        expect(view.getUint16(0)).toBe(1440);
        expect(view.getUint16(2)).toBe(1080);
        // 中身は1つで、位置は切り抜いたところ
        expect(parts[0].payload[10]).toBe(1);
        expect(view.getUint16(15)).toBe(100);
        expect(view.getUint16(17)).toBe(900);
    });

    test('消すほうは中身を持たない', () => {
        const parts = segments(writeSup([{ start: 0, end: 1, bitmap: sample }]));
        const clear = parts[5];
        expect(clear.type).toBe(0x16);
        expect(clear.payload[10]).toBe(0);
        expect(clear.payload).toHaveLength(11);
    });

    test('絵の長さには大きさのぶんも数える', () => {
        const parts = segments(writeSup([{ start: 0, end: 1, bitmap: sample }]));
        const ods = parts.find((p) => p.type === 0x15)!;
        const declared = (ods.payload[4] << 16) | (ods.payload[5] << 8) | ods.payload[6];
        // 宣言された長さ = 幅高さ(4バイト) + 走り書き
        expect(declared).toBe(ods.payload.length - 7);
    });

    test('色の表は256色ぶん必ず書く', () => {
        const parts = segments(writeSup([{ start: 0, end: 1, bitmap: sample }]));
        const pds = parts.find((p) => p.type === 0x14)!;
        expect(pds.payload).toHaveLength(2 + 256 * 5);
    });

    test('同じ絵が続いたら消して出し直さず、終わりだけ延ばす', () => {
        /*
         * 絵は字幕が出ている間ずっと1秒おきに流れてくる。そのまま書くと
         * 同じ時刻に「消す」と「出す」が並び、1枚30KBが毎秒増える
         * (実機の5分の番組で57枚 → まとめると11枚)
         */
        const writer = new SupWriter();
        writer.add(sample, 0, 1);
        writer.add(sample, 1, 2);
        writer.add(sample, 2, 3);
        expect(writer.captions).toBe(1);

        const parts = segments(writer.bytes());
        expect(parts.map((p) => p.type)).toEqual([0x16, 0x17, 0x14, 0x15, 0x80, 0x16, 0x17, 0x80]);
        // 消す時刻が最後まで延びている
        expect(parts.at(-1)?.pts).toBe(3 * 90_000);
    });

    test('絵が変われば出し直す', () => {
        const other = bitmap(1440, 1080, { x: 100, y: 900, w: 200, h: 40, color: [255, 0, 0, 255] });
        const writer = new SupWriter();
        writer.add(sample, 0, 1);
        writer.add(other, 1, 2);
        expect(writer.captions).toBe(2);
    });

    test('中身の無い絵は入れない', () => {
        const writer = new SupWriter();
        writer.add({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) }, 0, 1);
        expect(writer.captions).toBe(0);
        expect(writer.bytes()).toHaveLength(0);
    });
});
