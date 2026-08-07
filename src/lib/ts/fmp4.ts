/**
 * ffmpeg が吐く fMP4 を、MSE が食える単位に割る。
 *
 * MSE は**最初に init セグメント (`ftyp` + `moov`) を渡さないと**、そのあとの
 * 中身を1バイトも受け取らない。ffmpeg は1本の流れとして出してくるので、
 * こちらで切れ目を見つける。
 *
 *     ftyp moov | moof mdat | moof mdat | ...
 *     ~~~~~~~~~   ~~~~~~~~~
 *     init        媒体 (0.05秒ぶん。`live.ts` の `-frag_duration`)
 *
 * **途中から入ってきた人のために init は取っておく** ([stream.md](../../../docs/stream.md) §5.3)。
 * ライブは誰がいつ繋いでくるか分からないので、最初の1回だけ流して終わりにはできない。
 *
 * MP4 の箱は `[4バイト: 大きさ][4バイト: 種別][中身]` の繰り返し。
 * 大きさは箱ぜんぶ (頭の8バイトを含む) を数えた値。
 */

/** 箱の頭。大きさと種別で8バイト */
const HEADER = 8;

export type Segment = { kind: 'init'; data: Uint8Array } | { kind: 'media'; data: Uint8Array };

/**
 * バイト列を食わせると、組み上がったセグメントを返す。
 *
 * **足りないぶんは持ち越す。** ffmpeg の出力はパイプなので、箱の切れ目で
 * 届くとは限らない。半端なところで切って渡すと MSE がその場で投げる。
 */
export class Fmp4Splitter {
    private buffer = new Uint8Array(0);
    /** `moof` に入るまでが init。入ったら以降は媒体 */
    private started = false;
    /** 組み立て中の媒体セグメント (moof から次の moof の手前まで) */
    private pending: Uint8Array[] = [];

    feed(chunk: Uint8Array): Segment[] {
        const joined = new Uint8Array(this.buffer.length + chunk.length);
        joined.set(this.buffer);
        joined.set(chunk, this.buffer.length);
        this.buffer = joined;

        const out: Segment[] = [];
        let at = 0;
        for (;;) {
            if (this.buffer.length - at < HEADER) break;
            const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + at);
            const size = view.getUint32(0);
            /*
             * 大きさ 0 は「ここから最後まで」、1 は「次の8バイトに本当の大きさ」。
             * ffmpeg の fMP4 では出てこないが、来たら読めないので諦める
             * (黙って詰めると、以降ずっとずれたまま流れ続ける)
             */
            if (size < HEADER) break;
            if (this.buffer.length - at < size) break;

            const type = String.fromCharCode(
                this.buffer[at + 4],
                this.buffer[at + 5],
                this.buffer[at + 6],
                this.buffer[at + 7],
            );
            const box = this.buffer.slice(at, at + size);
            at += size;

            if (type === 'moof') {
                /*
                 * **`moof` が来たら、それまでが init。** 頭の `ftyp` `moov` を
                 * 溜めておいて、ここで1つにして出す
                 */
                if (!this.started && this.pending.length > 0) {
                    out.push({ kind: 'init', data: join(this.pending) });
                    this.pending = [];
                }
                this.started = true;
            }
            this.pending.push(box);

            /*
             * **`mdat` で1つ。** `moof` の次に `mdat` が来たら、その組が
             * 1フラグメント。次の `moof` を待って区切ると**必ず1つぶん遅れる**ので、
             * 細かく出させている (`-frag_duration`) 意味が無くなる。
             *
             * 数で区切らないのは、間に `sidx` などが挟まることがあるため。
             * 「2つ溜まったら出す」にしていると `moof`+`sidx` を1枚として
             * 出してしまい、中身の無いものを MSE に渡すことになる
             */
            if (this.started && type === 'mdat') {
                out.push({ kind: 'media', data: join(this.pending) });
                this.pending = [];
            }
        }
        this.buffer = this.buffer.slice(at);
        return out;
    }
}

function join(parts: Uint8Array[]): Uint8Array {
    let size = 0;
    for (const part of parts) size += part.length;
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
