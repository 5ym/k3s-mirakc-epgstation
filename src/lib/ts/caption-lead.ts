/**
 * **字幕が、放送の時計よりどれだけ先に来ているか** を TS から数える。
 *
 * 字幕は「いつ出すか」を持って流れてくるので、受け側が描く手間のぶん
 * 前もって送られる。その量は**局ごとに違う**:
 *
 *     NHK総合 562ms   Eテレ 564ms   MX 606ms   日テレ 799ms   TBS 835ms
 *
 * この差はそのまま「字幕が映像より先に出る量」の差になる。実測で並べると、
 * 差は 7ms のぶれに収まっている:
 *
 *     局        A (ここで数える量)   字幕が映像より先に出る量   差
 *     NHK総合        562ms                   497ms           -65
 *     MX             606ms                   543ms           -63
 *     日テレ         799ms                   748ms           -51
 *     TBS            835ms                   779ms           -56
 *
 * **決め打ちにすると、真ん中を採っても 0.15秒 残る。** ここを数えれば、残るのは
 * 焼き方で決まるぶんだけになる (`server/live.ts` の `captionLead`)。
 *
 * ffmpeg は要らない。**PCR と字幕の PTS を引き算するだけ**なので、TS を
 * 流している途中でそのまま数えられる。
 */

import { descriptors, PACKET, PacketStream, SectionAssembler, SYNC } from './psi';

/** 90kHz の一周 (2^33)。PCR も PTS もここで戻る */
const WRAP = 8589934592;
/** 数える本数。字幕は毎分18本くらいなので、これで1分ぶん */
const KEEP = 24;
/**
 * これだけ溜まったら答えを出す。
 *
 * 1本だけで決めると、たまたま早く送られた1枚に引きずられる。実測のぶれは
 * 上下1割で ±25ms なので、数本で足りる
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

/**
 * 1局ぶんの TS を食わせると、字幕の先回りの量 (秒) を出す。
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
    private pcr = -1;
    private readonly seen: number[] = [];

    /**
     * 数えた量 (秒)。**まだ分からなければ null。**
     *
     * 中央値を採る。字幕は数十秒あくことがあるので、平均だと1本の外れが長く残る
     */
    get lead(): number | null {
        if (this.seen.length < ENOUGH) return null;
        const sorted = this.seen.slice().sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
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
        if (this.pmt !== null && this.captionPid < 0) {
            for (const section of this.pmt.feed(packet)) this.readPmt(section);
        }
        if (pid !== this.captionPid) return;

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
        );
    }

    private count(pts: number): void {
        if (this.pcr < 0) return;
        let gap = pts - this.pcr;
        // 90kHz は 2^33 で一周する。跨いだ直後は近いほうへ寄せ直す
        if (gap < -WRAP / 2) gap += WRAP;
        if (gap > WRAP / 2) gap -= WRAP;
        const seconds = gap / 90000;
        if (Math.abs(seconds) > SANE) return;
        this.seen.push(seconds);
        if (this.seen.length > KEEP) this.seen.shift();
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
