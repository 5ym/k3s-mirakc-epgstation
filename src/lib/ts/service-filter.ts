/**
 * 物理チャンネル丸ごとの TS から、1つの局のぶんだけを抜き出す。
 *
 * mirakc が `/api/services/:id/stream` でやっていたこと。エージェントは
 * **中身を読まずに素の TS を流す**ので ([roadmap.md](../../../docs/roadmap.md))、
 * 選り分けるのは denpa の仕事になる。
 *
 * **これをやらないと1つの録画に複数の番組が入る。** 実機の TOKYO MX は
 * 1本の TS に MX1 と MX2 を載せていて、丸ごと保存すると ffprobe が2つの
 * プログラムを返す (これで CM 検出の fps を読み違えたことがある)。
 *
 * 残すもの:
 *
 * - **PAT** … その局1つだけに**書き直して**出す。丸ごと通すと ffmpeg には
 *   相変わらず複数のプログラムが見える
 * - **PMT と、そこに載っている ES** … 映像・音声・字幕。ECM も (掛かったまま
 *   録れたものを後から解くのに要る)
 * - **CAT / NIT / SDT / EIT / TDT** … 局の情報と番組表。EIT は放送の延長を
 *   追うのに使い、`.nfo` の元にもなる
 *
 * 落とすもの: 他局の PMT と ES、そして詰め物 (PID 0x1FFF)。
 */

import { crc32, PACKET, PacketStream, SectionAssembler, SYNC } from './psi';

const PID_PAT = 0x0000;
const PID_NULL = 0x1fff;

/**
 * 局に関係なく残す PID。**どれも数十バイト/秒**で、落として得るものが無い。
 *
 * CDT (ロゴ) はここに入れない。録画に要らないうえ、衛星では数百KBのカルーセルが
 * 流れてくる。ロゴを拾うのは録画の外でやる (logo.ts)
 */
const KEEP = new Set([
    0x0001, // CAT
    0x0010, // NIT
    0x0011, // SDT
    0x0012, // EIT
    0x0014, // TDT / TOT
]);

const TABLE_PAT = 0x00;
const TABLE_PMT = 0x02;
const DESC_CA = 0x09;

/** 1つの局に絞った PAT を組み立てる */
function buildPat(transportStreamId: number, version: number, serviceId: number, pmtPid: number): Uint8Array {
    const body = [
        TABLE_PAT,
        0xb0,
        0x00, // section_length はあとで埋める
        (transportStreamId >> 8) & 0xff,
        transportStreamId & 0xff,
        0xc1 | ((version & 0x1f) << 1),
        0x00, // section_number
        0x00, // last_section_number
        // NIT。番組表を読む側が居るので残す
        0x00,
        0x00,
        0xe0,
        0x10,
        (serviceId >> 8) & 0xff,
        serviceId & 0xff,
        0xe0 | ((pmtPid >> 8) & 0x1f),
        pmtPid & 0xff,
    ];
    const section = Uint8Array.from(body);
    const length = section.length - 3 + 4;
    section[1] = 0xb0 | ((length >> 8) & 0x0f);
    section[2] = length & 0xff;

    const out = new Uint8Array(section.length + 4);
    out.set(section);
    new DataView(out.buffer).setUint32(section.length, crc32(section));
    return out;
}

/** セクション1本を TS パケット1つに詰める。PAT は小さいので必ず収まる */
function packet(pid: number, section: Uint8Array, counter: number): Uint8Array {
    const out = new Uint8Array(PACKET).fill(0xff);
    out[0] = SYNC;
    out[1] = 0x40 | ((pid >> 8) & 0x1f);
    out[2] = pid & 0xff;
    out[3] = 0x10 | (counter & 0x0f);
    out[4] = 0x00; // pointer_field
    out.set(section.subarray(0, PACKET - 5), 5);
    return out;
}

/**
 * 局1つぶんに絞る。
 *
 * PAT が来るまでは**何も出さない**。どの PID がその局のものか決まらないためで、
 * PAT は 100ms ごとに流れてくるので待つのは一瞬。
 */
export class ServiceFilter {
    private readonly packets = new PacketStream();
    private readonly pat = new SectionAssembler(PID_PAT);
    private pmt: SectionAssembler | null = null;
    private pmtPid: number | null = null;
    /** その局のものとして通す PID。PMT を読むまでは空 */
    private readonly own = new Set<number>();
    /** 書き直した PAT。同じものを出し続けるので作り置きする */
    private rewritten: Uint8Array | null = null;
    private counter = 0;

    constructor(private readonly serviceId: number) {}

    /** その局の PMT を読めたか。読めるまで映像は1バイトも出ない */
    get ready(): boolean {
        return this.own.size > 0;
    }

    /**
     * 任意の長さのバイト列を食わせて、残すぶんを返す。
     *
     * 落とした PID の連続性カウンタは飛ぶが、**残す PID は元のまま**なので
     * 読む側から見て抜けは無い。自分で作るのは PAT だけで、そこは自前で数える。
     */
    filter(chunk: Uint8Array): Uint8Array {
        const out: Uint8Array[] = [];
        let length = 0;

        for (const ts of this.packets.feed(chunk)) {
            const pid = ((ts[1] & 0x1f) << 8) | ts[2];
            if (pid === PID_NULL) continue;

            if (pid === PID_PAT) {
                this.readPat(ts);
                // 元の PAT は捨てて、書き直したものを同じ回数だけ出す
                if (this.rewritten !== null && (ts[1] & 0x40) !== 0) {
                    out.push(packet(PID_PAT, this.rewritten, this.counter++));
                    length += PACKET;
                }
                continue;
            }

            if (pid === this.pmtPid) {
                this.readPmt(ts);
                out.push(ts);
                length += PACKET;
                continue;
            }

            if (KEEP.has(pid) || this.own.has(pid)) {
                out.push(ts);
                length += PACKET;
            }
        }

        const joined = new Uint8Array(length);
        let at = 0;
        for (const ts of out) {
            joined.set(ts, at);
            at += ts.length;
        }
        return joined;
    }

    private readPat(ts: Uint8Array): void {
        for (const section of this.pat.feed(ts)) {
            if (section[0] !== TABLE_PAT) continue;
            const transportStreamId = (section[3] << 8) | section[4];
            const version = (section[5] >> 1) & 0x1f;
            for (let at = 8; at + 4 <= section.length - 4; at += 4) {
                const programNumber = (section[at] << 8) | section[at + 1];
                if (programNumber !== this.serviceId) continue;
                const pmtPid = ((section[at + 2] & 0x1f) << 8) | section[at + 3];
                if (pmtPid === this.pmtPid) return;
                // 選局し直した・PAT が入れ替わった。PMT も読み直す
                this.pmtPid = pmtPid;
                this.pmt = new SectionAssembler(pmtPid);
                this.own.clear();
                this.rewritten = buildPat(transportStreamId, version, this.serviceId, pmtPid);
                return;
            }
        }
    }

    private readPmt(ts: Uint8Array): void {
        for (const section of this.pmt?.feed(ts) ?? []) {
            if (section[0] !== TABLE_PMT) continue;
            const pids = new Set<number>();

            // PCR。映像と同じ PID のことが多いが、別に振られていることもある
            const pcrPid = ((section[8] & 0x1f) << 8) | section[9];
            if (pcrPid !== 0x1fff) pids.add(pcrPid);

            const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
            collectCa(section.subarray(12, 12 + programInfoLength), pids);

            let at = 12 + programInfoLength;
            const end = section.length - 4;
            while (at + 5 <= end) {
                const elementaryPid = ((section[at + 1] & 0x1f) << 8) | section[at + 2];
                const infoLength = ((section[at + 3] & 0x0f) << 8) | section[at + 4];
                pids.add(elementaryPid);
                collectCa(section.subarray(at + 5, at + 5 + infoLength), pids);
                at += 5 + infoLength;
            }

            this.own.clear();
            for (const pid of pids) this.own.add(pid);
        }
    }
}

/** CA_descriptor から ECM の PID を拾う。掛かったまま録れたものを後から解くのに要る */
function collectCa(body: Uint8Array, into: Set<number>): void {
    let at = 0;
    while (at + 2 <= body.length) {
        const tag = body[at];
        const length = body[at + 1];
        if (tag === DESC_CA && length >= 4) {
            into.add(((body[at + 4] & 0x1f) << 8) | body[at + 5]);
        }
        at += 2 + length;
    }
}
