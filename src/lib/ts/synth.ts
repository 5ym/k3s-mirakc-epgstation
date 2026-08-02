/**
 * TS のセクションを組み立てる。
 *
 * 実チューナーが無いので、解析のテストにも偽 mirakc にも「それらしい TS」が要る。
 * 読む側 (psi.ts / logo.ts) と対になる書く側で、ここだけが仕様の写し。
 */

import { crc32, PACKET, SYNC } from './psi';

/** セクション本体に CRC32 を付ける。section_length も実長に直す */
export function withCrc(body: number[]): Uint8Array {
    const section = Uint8Array.from(body);
    const length = section.length - 3 + 4;
    section[1] = 0xb0 | ((length >> 8) & 0x0f);
    section[2] = length & 0xff;

    const out = new Uint8Array(section.length + 4);
    out.set(section);
    new DataView(out.buffer).setUint32(section.length, crc32(section));
    return out;
}

const be = (value: number) => [(value >> 8) & 0xff, value & 0xff];

export function sdtSection(
    transportStreamId: number,
    originalNetworkId: number,
    services: [number, number][],
): Uint8Array {
    const body = [
        0x42,
        0x00,
        0x00,
        ...be(transportStreamId),
        0xc1,
        0x00,
        0x00,
        ...be(originalNetworkId),
        0xff,
    ];
    for (const [serviceId, serviceType] of services) {
        // service_descriptor (0x48): 種別 + 事業者名 + サービス名
        const descriptor = [0x48, 0x03, serviceType, 0x00, 0x00];
        body.push(...be(serviceId), 0xfc, ...be(0x8000 | descriptor.length), ...descriptor);
    }
    return withCrc(body);
}

export function nitSection(
    networkId: number,
    remoteControlKeyId: number | null,
    streams: [number, number, [number, number][]][],
): Uint8Array {
    const body = [0x40, 0x00, 0x00, ...be(networkId), 0xc1, 0x00, 0x00, ...be(0xf000)];

    const loop: number[] = [];
    for (const [transportStreamId, originalNetworkId, services] of streams) {
        const descriptors: number[] = [];
        // TS information descriptor (0xCD)
        if (remoteControlKeyId !== null) descriptors.push(0xcd, 0x02, remoteControlKeyId, 0x00);
        const serviceList = services.flatMap(([id, type]) => [...be(id), type]);
        descriptors.push(0x41, serviceList.length, ...serviceList);

        loop.push(
            ...be(transportStreamId),
            ...be(originalNetworkId),
            ...be(0xf000 | descriptors.length),
            ...descriptors,
        );
    }

    body.push(...be(0xf000 | loop.length), ...loop);
    return withCrc(body);
}

/** セクションを TS パケットに詰める。頭のパケットには pointer_field が付く */
export function packetize(pid: number, section: Uint8Array, counter = 0): Uint8Array {
    const packets: number[] = [];
    let data = [0x00, ...section]; // pointer_field = 0
    let first = true;
    while (data.length > 0) {
        const chunk = data.slice(0, PACKET - 4);
        data = data.slice(PACKET - 4);
        packets.push(SYNC, (first ? 0x40 : 0x00) | (pid >> 8), pid & 0xff, 0x10 | (counter & 0x0f));
        packets.push(...chunk, ...new Array(PACKET - 4 - chunk.length).fill(0xff));
        counter++;
        first = false;
    }
    return Uint8Array.from(packets);
}
