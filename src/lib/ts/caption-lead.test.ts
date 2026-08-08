import { describe, expect, test } from 'bun:test';
import { CaptionLead } from './caption-lead';
import { PACKET } from './psi';
import { packetize, patSection, programMap } from './synth';

const SERVICE = 1024;
const PMT_PID = 0x1f0;
const VIDEO_PID = 0x100;
const PCR_PID = VIDEO_PID;
const CAPTION_PID = 0x130;
const SUPER_PID = 0x138;

/** 部品タグの記述子。0x30〜0x37 が字幕、0x38〜 が文字スーパー */
const componentTag = (tag: number) => [0x52, 0x01, tag];

const pat = () => packetize(0x0000, patSection([[SERVICE, PMT_PID]]));

const pmt = (streams: ([number, number] | [number, number, number[]])[]) =>
    packetize(PMT_PID, programMap(SERVICE, PCR_PID, streams));

const normal = () =>
    pmt([
        [0x02, VIDEO_PID],
        [0x0f, 0x110],
        [0x06, CAPTION_PID, componentTag(0x30)],
        [0x06, SUPER_PID, componentTag(0x38)],
    ]);

/** PCR だけを運ぶパケット。適応領域のみで中身は無し */
function pcrPacket(pcr: number): Uint8Array {
    const out = new Uint8Array(PACKET).fill(0xff);
    out[0] = 0x47;
    out[1] = (PCR_PID >> 8) & 0x1f;
    out[2] = PCR_PID & 0xff;
    // 適応領域だけ (中身なし)
    out[3] = 0x20;
    out[4] = 183;
    out[5] = 0x10;
    out[6] = (pcr / 33554432) & 0xff;
    out[7] = (pcr / 131072) & 0xff;
    out[8] = (pcr / 512) & 0xff;
    out[9] = (pcr / 2) & 0xff;
    out[10] = ((pcr & 1) << 7) | 0x7e;
    return out;
}

/** 時刻を持つ PES の頭。字幕は private_stream_1 で流れてくる */
function pesPacket(pid: number, pts: number): Uint8Array {
    const out = new Uint8Array(PACKET).fill(0xff);
    out[0] = 0x47;
    out[1] = 0x40 | ((pid >> 8) & 0x1f);
    out[2] = pid & 0xff;
    out[3] = 0x10;
    const pes = out.subarray(4);
    pes[0] = 0x00;
    pes[1] = 0x00;
    pes[2] = 0x01;
    pes[3] = 0xbd;
    pes[4] = 0x00;
    pes[5] = 0x20;
    pes[6] = 0x80;
    pes[7] = 0x80;
    pes[8] = 0x05;
    pes[9] = 0x21 | ((pts / 536870912) & 0x0e);
    pes[10] = (pts / 4194304) & 0xff;
    pes[11] = 0x01 | ((pts / 16384) & 0xfe);
    pes[12] = (pts / 128) & 0xff;
    pes[13] = 0x01 | ((pts * 2) & 0xfe);
    return out;
}

const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

/** PCR を置いてから、その `ms` ミリ秒先の時刻を持つ字幕を流す */
function ahead(lead: CaptionLead, pcr: number, ms: number, pid = CAPTION_PID): void {
    lead.feed(join(pcrPacket(pcr), pesPacket(pid, pcr + Math.round((ms / 1000) * 90000))));
}

/**
 * **字幕は放送の時計より先に来る。** 局ごとに違うので、決め打ちにすると
 * そのぶん字幕の出るところがずれる (実機で NHK総合 562ms・TBS 835ms)。
 */
describe('CaptionLead', () => {
    const started = () => {
        const lead = new CaptionLead();
        lead.feed(join(pat(), normal()));
        return lead;
    };

    test('字幕の時刻と PCR の差を出す', () => {
        const lead = started();
        for (let i = 0; i < 5; i++) ahead(lead, 90000 * (100 + i), 600);
        expect(lead.lead).toBeCloseTo(0.6, 3);
    });

    /** 1本で決めると、たまたま早く送られた1枚に引きずられる */
    test('数え足りないうちは分からないと言う', () => {
        const lead = started();
        expect(lead.lead).toBeNull();
        ahead(lead, 9000000, 600);
        expect(lead.lead).toBeNull();
    });

    /** 真ん中を採る。飛び値1つで動かない */
    test('外れた1本に引きずられない', () => {
        const lead = started();
        for (const ms of [600, 610, 590, 3000, 605]) ahead(lead, 9000000, ms);
        expect(lead.lead).toBeCloseTo(0.605, 2);
    });

    /**
     * **文字スーパーは採らない。** あちらは部品タグ 0x38〜 で、ffmpeg が
     * 出しているのは字幕 (0x30〜) のほう
     */
    test('文字スーパーは数えない', () => {
        const lead = started();
        for (let i = 0; i < 5; i++) ahead(lead, 9000000, 2000, SUPER_PID);
        expect(lead.lead).toBeNull();
    });

    /** 90kHz は 2^33 で一周する。跨いだ直後に大きな値を拾わない */
    test('時計が一周しても狂わない', () => {
        const lead = started();
        // PCR は一周の直前。**字幕の時刻は回った先**になる
        for (let i = 0; i < 5; i++) {
            const pcr = 8589934592 - 18000 - i;
            const pts = (pcr + 54000) % 8589934592;
            expect(pts).toBeLessThan(pcr);
            lead.feed(join(pcrPacket(pcr), pesPacket(CAPTION_PID, pts)));
        }
        expect(lead.lead).toBeCloseTo(0.6, 3);
    });

    /** ありえない差は捨てる。選局した直後などに出る */
    test('離れすぎているものは捨てる', () => {
        const lead = started();
        for (let i = 0; i < 5; i++) ahead(lead, 9000000, 30000);
        expect(lead.lead).toBeNull();
    });

    /** PMT を読むまでは、どの PID が字幕かも分からない */
    test('PMT が来る前は数えない', () => {
        const lead = new CaptionLead();
        for (let i = 0; i < 5; i++) ahead(lead, 9000000, 600);
        expect(lead.lead).toBeNull();
    });
});
