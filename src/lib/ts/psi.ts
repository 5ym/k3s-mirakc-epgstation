/**
 * TS から局の一覧を読む。チャンネルスキャンで「この物理チャンネルに何が居るか」を知るために使う。
 *
 * 必要なのは NIT と SDT の2つだけ。
 *
 * - NIT (PID 0x0010) … ネットワークID と、地上波ならリモコン番号
 * - SDT (PID 0x0011) … その TS に入っているサービスのIDと種別
 *
 * 局名は読まない。ARIB の文字符号は独自で、まともに解くには外字や漢字集合まで
 * 面倒を見ることになる。名前は mirakc が起動後に自分で拾うので、こちらは
 * 「どの物理チャンネルに何番のサービスが居るか」だけ分かればよい。
 */

export const PACKET = 188;
export const SYNC = 0x47;

const PID_NIT = 0x0010;
const PID_SDT = 0x0011;

const TABLE_NIT_ACTUAL = 0x40;
const TABLE_SDT_ACTUAL = 0x42;

const DESC_SERVICE_LIST = 0x41;
const DESC_SERVICE = 0x48;
const DESC_TS_INFORMATION = 0xcd;

/**
 * 録るに値するサービス種別。Mirakurun のスキャンが通しているものと同じ。
 * データ放送やワンセグを混ぜると、映像の無いものが番組表に並ぶ
 */
export const SERVICE_TYPES = new Set([0x01, 0x02, 0xa1, 0xa4, 0xa5, 0xad, 0xc0]);

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let crc = i << 24;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
        }
        table[i] = crc >>> 0;
    }
    return table;
})();

/** MPEG-2 の CRC32。セクション末尾の4バイトを含めて回すと 0 になる */
export function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc = (((crc << 8) >>> 0) ^ CRC32_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    }
    return crc >>> 0;
}

export interface Service {
    serviceId: number;
    serviceType: number;
}

export interface TransportInfo {
    transportStreamId: number;
    originalNetworkId: number;
    services: Service[];
}

export interface NetworkInfo {
    networkId: number;
    remoteControlKeyId: number | null;
    transportStreams: TransportInfo[];
}

/**
 * PSI セクションを組み立てる。
 *
 * セクションは TS パケットをまたいで運ばれ、パケットの切れ目とは無関係な
 * 位置で終わる。payload_unit_start_indicator と pointer_field を見て
 * 頭を合わせ、section_length ぶん溜まったら1本として吐く。
 */
export class SectionAssembler {
    private buffer = new Uint8Array(0);

    constructor(private readonly pid: number) {}

    /** パケットを1つ食わせる。組み上がったセクションを返す */
    feed(packet: Uint8Array): Uint8Array[] {
        if (packet[0] !== SYNC) return [];
        const pid = ((packet[1] & 0x1f) << 8) | packet[2];
        if (pid !== this.pid) return [];
        // トランスポートエラーが立っているものは信用しない
        if (packet[1] & 0x80) return [];

        const adaptation = (packet[3] >> 4) & 0x03;
        if (adaptation === 0 || adaptation === 2) return [];
        let offset = 4;
        if (adaptation === 3) offset += 1 + packet[4];
        if (offset >= PACKET) return [];

        const payload = packet.subarray(offset);
        if (packet[1] & 0x40) {
            const pointer = payload[0];
            if (1 + pointer > payload.length) return [];
            // pointer_field の手前は前のセクションの続き
            this.append(payload.subarray(1, 1 + pointer));
            const done = this.flush();
            this.buffer = payload.slice(1 + pointer);
            return [...done, ...this.flush()];
        }

        this.append(payload);
        return this.flush();
    }

    private append(data: Uint8Array): void {
        if (this.buffer.length === 0) return;
        const joined = new Uint8Array(this.buffer.length + data.length);
        joined.set(this.buffer);
        joined.set(data, this.buffer.length);
        this.buffer = joined;
    }

    private flush(): Uint8Array[] {
        const sections: Uint8Array[] = [];
        for (;;) {
            if (this.buffer.length < 3) return sections;
            // 詰め物。ここから先にセクションは無い
            if (this.buffer[0] === 0xff) {
                this.buffer = new Uint8Array(0);
                return sections;
            }
            const length = 3 + (((this.buffer[1] & 0x0f) << 8) | this.buffer[2]);
            if (this.buffer.length < length) return sections;
            const section = this.buffer.slice(0, length);
            this.buffer = this.buffer.slice(length);
            // 壊れたセクションを読むと嘘の局が並ぶので、CRC を通ったものだけ使う
            if (crc32(section) === 0) sections.push(section);
        }
    }
}

/**
 * 同期が取れているとみなすのに必要な連続パケット数。
 * 1つだけでは中身のたまたまの 0x47 を頭と誤認する
 */
const CONFIRM = 3;

/** `from` 以降で、188 間隔に 0x47 が続くところを探す。無ければ -1 */
function findSync(data: Uint8Array, from = 0): number {
    for (let at = from; at + PACKET * (CONFIRM - 1) < data.length; at++) {
        let ok = true;
        for (let i = 0; i < CONFIRM; i++) {
            if (data[at + i * PACKET] !== SYNC) {
                ok = false;
                break;
            }
        }
        if (ok) return at;
    }
    return -1;
}

/**
 * 任意の長さで届くバイト列を 188 バイトのパケットに切り分ける。
 *
 * 頭が必ずパケットの先頭とは限らず、電波が弱いと途中で数バイト落ちる。
 * ずれたままだと**以降ずっと1パケットも読めなくなる**ので、頭が 0x47 でなければ
 * 取り直す。普段は先頭が 0x47 なので、探しに行くのはずれたときだけ。
 */
export class PacketStream {
    private rest = new Uint8Array(0);

    *feed(chunk: Uint8Array): Generator<Uint8Array> {
        const data = new Uint8Array(this.rest.length + chunk.length);
        data.set(this.rest);
        data.set(chunk, this.rest.length);

        let at = 0;
        while (at + PACKET <= data.length) {
            if (data[at] !== SYNC) {
                const found = findSync(data, at);
                if (found < 0) break;
                at = found;
                if (at + PACKET > data.length) break;
            }
            yield data.subarray(at, at + PACKET);
            at += PACKET;
        }
        // 同期が取れないまま溜め込まないよう、頭を探せるぶんだけ残す
        this.rest = data.slice(Math.max(at, data.length - PACKET * CONFIRM));
    }
}

/** 記述子の並びを (tag, 中身) に切り分ける */
export function* descriptors(data: Uint8Array): Generator<[number, Uint8Array]> {
    let at = 0;
    while (at + 2 <= data.length) {
        const tag = data[at];
        const length = data[at + 1];
        const body = data.subarray(at + 2, at + 2 + length);
        if (body.length < length) return;
        yield [tag, body];
        at += 2 + length;
    }
}

/** SDT からサービスの一覧を読む。自分の TS のものだけ */
export function parseSdt(section: Uint8Array): TransportInfo | null {
    if (section[0] !== TABLE_SDT_ACTUAL) return null;

    const services: Service[] = [];
    let at = 11;
    const end = section.length - 4;
    while (at + 5 <= end) {
        const serviceId = (section[at] << 8) | section[at + 1];
        const loop = ((section[at + 3] & 0x0f) << 8) | section[at + 4];
        const body = section.subarray(at + 5, at + 5 + loop);
        at += 5 + loop;

        for (const [tag, descriptor] of descriptors(body)) {
            if (tag === DESC_SERVICE && descriptor.length > 0) {
                services.push({ serviceId, serviceType: descriptor[0] });
                break;
            }
        }
    }

    return {
        transportStreamId: (section[3] << 8) | section[4],
        originalNetworkId: (section[8] << 8) | section[9],
        services,
    };
}

/** NIT からネットワークIDとリモコン番号、他の TS の顔ぶれを読む */
export function parseNit(section: Uint8Array): NetworkInfo | null {
    if (section[0] !== TABLE_NIT_ACTUAL) return null;

    const networkLength = ((section[8] & 0x0f) << 8) | section[9];
    let at = 10 + networkLength;
    if (at + 2 > section.length) return null;
    at += 2; // transport_stream_loop_length

    let remoteControlKeyId: number | null = null;
    const transportStreams: TransportInfo[] = [];
    const end = section.length - 4;
    while (at + 6 <= end) {
        const transportStreamId = (section[at] << 8) | section[at + 1];
        const originalNetworkId = (section[at + 2] << 8) | section[at + 3];
        const loop = ((section[at + 4] & 0x0f) << 8) | section[at + 5];
        const body = section.subarray(at + 6, at + 6 + loop);
        at += 6 + loop;

        const services: Service[] = [];
        for (const [tag, descriptor] of descriptors(body)) {
            if (tag === DESC_TS_INFORMATION && descriptor.length > 0 && remoteControlKeyId === null) {
                remoteControlKeyId = descriptor[0];
            } else if (tag === DESC_SERVICE_LIST) {
                for (let i = 0; i + 3 <= descriptor.length; i += 3) {
                    services.push({
                        serviceId: (descriptor[i] << 8) | descriptor[i + 1],
                        serviceType: descriptor[i + 2],
                    });
                }
            }
        }
        transportStreams.push({ transportStreamId, originalNetworkId, services });
    }

    return { networkId: (section[3] << 8) | section[4], remoteControlKeyId, transportStreams };
}

export interface FoundService extends Service {
    networkId: number;
    transportStreamId: number;
    remoteControlKeyId: number | null;
}

/**
 * 流れてくる TS を食べて、NIT と SDT が揃うまで待つ。
 *
 * Mirakurun のスキャンと同じで、**両方**揃って初めてそのチャンネルを
 * 「受信できた」とみなす。SDT だけ取れても、どのネットワークのものか
 * 分からないと設定に書けない。
 */
export class ServiceReader {
    private readonly nit = new SectionAssembler(PID_NIT);
    private readonly sdt = new SectionAssembler(PID_SDT);
    private readonly packets = new PacketStream();

    network: NetworkInfo | null = null;
    transport: TransportInfo | null = null;

    get complete(): boolean {
        return this.network !== null && this.transport !== null;
    }

    /** 任意の長さのバイト列を食わせる。揃ったら true */
    feed(chunk: Uint8Array): boolean {
        for (const packet of this.packets.feed(chunk)) {
            if (this.network === null) {
                for (const section of this.nit.feed(packet)) {
                    this.network = parseNit(section) ?? this.network;
                }
            }
            if (this.transport === null) {
                for (const section of this.sdt.feed(packet)) {
                    this.transport = parseSdt(section) ?? this.transport;
                }
            }
        }
        return this.complete;
    }

    /** 録るに値するサービスだけ。リモコン番号は NIT のものを配る */
    services(): FoundService[] {
        if (this.network === null || this.transport === null) return [];
        const { networkId, remoteControlKeyId } = this.network;
        const { transportStreamId } = this.transport;
        return this.transport.services
            .filter((service) => SERVICE_TYPES.has(service.serviceType))
            .map((service) => ({ ...service, networkId, transportStreamId, remoteControlKeyId }));
    }
}
