/**
 * **電波の中で、字幕が映像よりどれだけ先に来ているか** を TS から数える。
 *
 * 放送は**字幕も映像も前もって送る**。字幕は受け側が描く手間のぶん、映像は
 * 復号器の溜め (VBV) のぶん。どちらも局ごとに違うが、**差はほぼ揃う**:
 *
 *     局        字幕 A_c   映像 A_v   差
 *     NHK総合    561ms      269ms    292
 *     TBS        825ms      504ms    321
 *     日テレ     795ms      488ms    307
 *
 * **見るのは差のほう。** 片方だけ数えていた頃は、映像の先回りがまるごと
 * 落ちていて、待たせる量が 0.2〜0.3秒 過大になっていた。
 *
 * ここに焼く遅れを足したものが「受け側が待たせる量」になる
 * (`server/live.ts` の `captionLead`)。
 *
 * ffmpeg は要らない。**PCR と PTS を引き算するだけ**なので、TS を流している
 * 途中でそのまま数えられる。
 */

import { descriptors, PACKET, PacketStream, SectionAssembler, SYNC } from './psi';

/** 90kHz の一周 (2^33)。PCR も PTS もここで戻る */
const WRAP = 8589934592;
/** 数える本数。字幕は毎分18本くらいなので、これで1分ぶん */
const KEEP = 24;
/**
 * これだけ溜まったら答えを出す。
 *
 * 1本だけで決めると、たまたま早く送られた1枚に引きずられる。**ぶれは小さい** —
 * 60秒ぶん数えると NHK総合が 531〜590ms (中央 565)、TBS が 789〜865ms (中央 831)
 * で、±40ms に収まっている。数本で足りる
 */
const ENOUGH = 3;
/** ありえない値は捨てる (秒)。放送の時計を跨いだ直後などに出る */
const SANE = 10;

/** ARIB の部品タグ。字幕は 0x30〜0x37、文字スーパーは 0x38〜 */
const COMPONENT_TAG = 0x52;
const CAPTION_TAG_FIRST = 0x30;
const CAPTION_TAG_LAST = 0x37;
/** 字幕もデータ放送も、PMT ではこれ (ITU-T H.222.0 の private PES) */
const STREAM_TYPE_PRIVATE = 0x06;
/** 放送の映像は MPEG-2。**ワンセグ (H.264 = 0x1b) は採らない** */
const STREAM_TYPE_MPEG2 = 0x02;

/**
 * 1局ぶんの TS を食わせると、**字幕と映像の先回りの差** (秒) を出す。
 *
 * **渡すのは1局に絞ったあとの TS** (`ServiceFilter` を通したもの)。丸ごとだと
 * 別の局の PMT を拾ってしまう。
 */
export class CaptionLead {
    private readonly packets = new PacketStream();
    private readonly pat = new SectionAssembler(0);
    private pmt: SectionAssembler | null = null;
    private pcrPid = -1;
    /** 字幕の PID。**PMT の並びで最初の1本**だけ見る (ffmpeg の `s:0` と同じ) */
    private captionPid = -1;
    /** 映像の PID。こちらの先回りも数えて差を採る */
    private videoPid = -1;
    private pcr = -1;
    private readonly seen: number[] = [];
    private readonly seenVideo: number[] = [];

    /**
     * 字幕と映像の先回りの差 (秒)。**まだ分からなければ null。**
     *
     * 中央値どうしを引く。字幕は数十秒あくことがあるので、平均だと1本の
     * 外れが長く残る。映像は毎秒何十本も来るので、こちらはすぐ埋まる
     */
    get lead(): number | null {
        const caption = middle(this.seen);
        const video = middle(this.seenVideo);
        if (caption === null || video === null) return null;
        return caption - video;
    }

    /** 1局に絞った TS を食わせる */
    feed(chunk: Uint8Array): void {
        for (const packet of this.packets.feed(chunk)) this.packet(packet);
    }

    private packet(packet: Uint8Array): void {
        if (packet[0] !== SYNC) return;
        const pid = ((packet[1] & 0x1f) << 8) | packet[2];
        const adaptation = (packet[3] >> 4) & 0x03;

        // PCR は適応領域に乗る。**これが放送の時計**
        if (pid === this.pcrPid && (adaptation === 2 || adaptation === 3) && packet[4] > 0) {
            if ((packet[5] & 0x10) !== 0) {
                this.pcr =
                    packet[6] * 33554432 +
                    packet[7] * 131072 +
                    packet[8] * 512 +
                    packet[9] * 2 +
                    (packet[10] >> 7);
            }
        }

        if (pid === 0) {
            for (const section of this.pat.feed(packet)) this.readPat(section);
            return;
        }
        if (this.pmt !== null && (this.captionPid < 0 || this.videoPid < 0)) {
            for (const section of this.pmt.feed(packet)) this.readPmt(section);
        }
        if (pid !== this.captionPid && pid !== this.videoPid) return;

        if (adaptation === 0 || adaptation === 2) return;
        let at = 4;
        if (adaptation === 3) at += 1 + packet[4];
        if (at >= PACKET) return;
        // PES の頭にだけ時刻が乗る
        if ((packet[1] & 0x40) === 0) return;
        const pes = packet.subarray(at);
        if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return;
        if ((pes[7] & 0x80) === 0) return;
        this.count(
            (pes[9] & 0x0e) * 536870912 +
                pes[10] * 4194304 +
                ((pes[11] & 0xfe) >> 1) * 32768 +
                pes[12] * 128 +
                ((pes[13] & 0xfe) >> 1),
            pid === this.captionPid ? this.seen : this.seenVideo,
        );
    }

    private count(pts: number, into: number[]): void {
        if (this.pcr < 0) return;
        let gap = pts - this.pcr;
        // 90kHz は 2^33 で一周する。跨いだ直後は近いほうへ寄せ直す
        if (gap < -WRAP / 2) gap += WRAP;
        if (gap > WRAP / 2) gap -= WRAP;
        const seconds = gap / 90000;
        if (Math.abs(seconds) > SANE) return;
        into.push(seconds);
        if (into.length > KEEP) into.shift();
    }

    private readPat(section: Uint8Array): void {
        // 1局に絞ってあるので、載っているのは1つだけ
        for (let at = 8; at + 4 <= section.length - 4; at += 4) {
            const program = (section[at] << 8) | section[at + 1];
            if (program === 0) continue;
            const pid = ((section[at + 2] & 0x1f) << 8) | section[at + 3];
            if (this.pmt === null) this.pmt = new SectionAssembler(pid);
            return;
        }
    }

    private readPmt(section: Uint8Array): void {
        this.pcrPid = ((section[8] & 0x1f) << 8) | section[9];
        const infoLength = ((section[10] & 0x0f) << 8) | section[11];
        let at = 12 + infoLength;
        const end = section.length - 4;
        while (at + 5 <= end) {
            const type = section[at];
            const pid = ((section[at + 1] & 0x1f) << 8) | section[at + 2];
            const length = ((section[at + 3] & 0x0f) << 8) | section[at + 4];
            if (type === STREAM_TYPE_MPEG2 && this.videoPid < 0) this.videoPid = pid;
            if (type === STREAM_TYPE_PRIVATE && this.captionPid < 0) {
                for (const [tag, body] of descriptors(section.subarray(at + 5, at + 5 + length))) {
                    // **文字スーパー (0x38〜) は採らない。** あちらは別の口で流れてくる
                    if (
                        tag === COMPONENT_TAG &&
                        body[0] >= CAPTION_TAG_FIRST &&
                        body[0] <= CAPTION_TAG_LAST
                    ) {
                        this.captionPid = pid;
                    }
                }
            }
            at += 5 + length;
        }
    }
}

/** 真ん中の値。**足りなければ null** */
function middle(values: number[]): number | null {
    if (values.length < ENOUGH) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}
