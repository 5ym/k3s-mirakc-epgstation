import { describe, expect, test } from 'bun:test';
import { Fmp4Splitter } from './fmp4';

/** 箱を1つ組み立てる。中身は大きさが分かればよいので詰め物 */
function box(type: string, fill = 0, size = 4): Uint8Array {
    const out = new Uint8Array(8 + size);
    new DataView(out.buffer).setUint32(0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.fill(fill, 8);
    return out;
}

function join(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

describe('fMP4 を割る', () => {
    /*
     * MSE は init セグメント (`ftyp` + `moov`) を先に渡さないと、そのあとの
     * 中身を1バイトも受け取らない。ffmpeg は1本の流れで出してくる
     */
    test('頭の ftyp + moov が init になる', () => {
        const splitter = new Fmp4Splitter();
        const out = splitter.feed(join(box('ftyp'), box('moov'), box('moof'), box('mdat')));
        expect(out.map((s) => s.kind)).toEqual(['init', 'media']);
        expect(out[0].data).toEqual(join(box('ftyp'), box('moov')));
        expect(out[1].data).toEqual(join(box('moof'), box('mdat')));
    });

    test('moof + mdat の組が1枚ずつ出る', () => {
        const splitter = new Fmp4Splitter();
        splitter.feed(join(box('ftyp'), box('moov')));
        const out = splitter.feed(join(box('moof', 1), box('mdat', 1), box('moof', 2), box('mdat', 2)));
        expect(out.map((s) => s.kind)).toEqual(['init', 'media', 'media']);
        expect(out[1].data).toEqual(join(box('moof', 1), box('mdat', 1)));
        expect(out[2].data).toEqual(join(box('moof', 2), box('mdat', 2)));
    });

    /*
     * **パイプは箱の切れ目で届かない。** 半端なところで切って MSE に渡すと
     * その場で投げる。1バイトずつ食わせても同じ答えになること
     */
    test('どこで切って食わせても同じ', () => {
        const whole = join(box('ftyp'), box('moov'), box('moof', 1), box('mdat', 1));
        const splitter = new Fmp4Splitter();
        const out = [];
        for (const byte of whole) out.push(...splitter.feed(Uint8Array.of(byte)));
        expect(out.map((s) => s.kind)).toEqual(['init', 'media']);
        expect(out[0].data).toEqual(join(box('ftyp'), box('moov')));
        expect(out[1].data).toEqual(join(box('moof', 1), box('mdat', 1)));
    });

    /*
     * **数で区切らない。** 「2つ溜まったら出す」にしていると `moof` + `sidx` を
     * 1枚として出してしまい、中身の無いものを MSE に渡すことになる
     */
    test('moof と mdat の間に別の箱が挟まっても、1枚として出す', () => {
        const splitter = new Fmp4Splitter();
        const out = splitter.feed(join(box('ftyp'), box('moov'), box('moof'), box('sidx'), box('mdat')));
        expect(out.map((s) => s.kind)).toEqual(['init', 'media']);
        expect(out[1].data).toEqual(join(box('moof'), box('sidx'), box('mdat')));
    });

    /*
     * **init は `moof` が見えた時点で出す。** そこで頭が終わったと分かるので、
     * `mdat` まで待つ理由が無い。繋いできた人を1枚ぶん待たせないで済む
     */
    test('init は moof が見えた時点で出す。媒体は mdat まで待つ', () => {
        const splitter = new Fmp4Splitter();
        expect(splitter.feed(join(box('ftyp'), box('moov')))).toEqual([]);
        expect(splitter.feed(box('moof')).map((s) => s.kind)).toEqual(['init']);
        expect(splitter.feed(box('mdat')).map((s) => s.kind)).toEqual(['media']);
    });
});
