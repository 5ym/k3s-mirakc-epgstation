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

/** PAT。サービスID → PMT の PID */
export function patSection(programs: [number, number][]): Uint8Array {
    const body = [0x00, 0x00, 0x00, ...be(1), 0xc1, 0x00, 0x00];
    for (const [serviceId, pmtPid] of programs) {
        body.push(...be(serviceId), 0xe0 | (pmtPid >> 8), pmtPid & 0xff);
    }
    return withCrc(body);
}

/**
 * PMT。ロゴのカルーセルが乗る ES を1つだけ持たせる。
 * 目印は stream_identifier_descriptor (0x52) の component_tag
 */
export function pmtSection(serviceId: number, esPid: number, componentTag: number): Uint8Array {
    return withCrc([
        0x02,
        0x00,
        0x00,
        ...be(serviceId),
        0xc1,
        0x00,
        0x00,
        0xe0,
        0x00, // PCR_PID
        0xf0,
        0x00, // program_info_length = 0
        0x0d, // stream_type: DSM-CC セクション
        0xe0 | (esPid >> 8),
        esPid & 0xff,
        0xf0,
        0x03,
        0x52,
        0x01,
        componentTag,
    ]);
}

/** DSM-CC のセクションで包む */
function dsmccSection(tableId: number, message: number[]): Uint8Array {
    return withCrc([tableId, 0x00, 0x00, ...be(0), 0xc1, 0x00, 0x00, ...message]);
}

/** DII。「このモジュールは何バイトで、名前は何か」を伝える */
export function diiSection(
    downloadId: number,
    blockSize: number,
    module: { moduleId: number; moduleSize: number; moduleVersion: number; name: string },
): Uint8Array {
    const name = [...new TextEncoder().encode(module.name)];
    const info = [0x02, name.length, ...name];
    const rest = [
        ...be(downloadId >> 16),
        ...be(downloadId & 0xffff),
        ...be(blockSize),
        0x00, // windowSize
        0x00, // ackPeriod
        0,
        0,
        0,
        0, // tCDownloadWindow
        0,
        0,
        0,
        0, // tCDownloadScenario
        ...be(0), // compatibilityDescriptor: 長さ0
        ...be(1), // numberOfModules
        ...be(module.moduleId),
        ...be(module.moduleSize >> 16),
        ...be(module.moduleSize & 0xffff),
        module.moduleVersion,
        info.length,
        ...info,
        ...be(0), // privateDataLength
    ];
    return dsmccSection(0x3b, [
        0x11, // protocolDiscriminator
        0x03, // dsmccType
        ...be(0x1002), // messageId: DII
        0,
        0,
        0,
        1, // transaction_id
        0xff,
        0x00, // reserved / adaptationLength
        ...be(rest.length),
        ...rest,
    ]);
}

/** DDB。モジュールを割ったブロックを1つ運ぶ */
export function ddbSection(
    downloadId: number,
    moduleId: number,
    moduleVersion: number,
    blockNumber: number,
    block: Uint8Array,
): Uint8Array {
    return dsmccSection(0x3c, [
        0x11,
        0x03,
        ...be(0x1003), // messageId: DDB
        ...be(downloadId >> 16),
        ...be(downloadId & 0xffff),
        0xff,
        0x00, // reserved / adaptationLength
        ...be(block.length + 6),
        ...be(moduleId),
        moduleVersion,
        0xff,
        ...be(blockNumber),
        ...block,
    ]);
}

/** ロゴデータモジュール (ARIB STD-B21)。カルーセルで運ばれる中身 */
export function logoModule(
    logoType: number,
    logos: { logoId: number; services: [number, number][]; data: Uint8Array }[],
): Uint8Array {
    const body = [logoType, ...be(logos.length)];
    for (const logo of logos) {
        body.push(...be(logo.logoId), logo.services.length);
        for (const [networkId, serviceId] of logo.services) {
            body.push(...be(networkId), ...be(0), ...be(serviceId));
        }
        body.push(...be(logo.data.length), ...logo.data);
    }
    return Uint8Array.from(body);
}
