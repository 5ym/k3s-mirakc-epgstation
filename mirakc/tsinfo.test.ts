import { describe, expect, test } from 'bun:test';
import { crc32, PACKET, parseNit, parseSdt, ServiceReader, SYNC } from './tsinfo';

/**
 * 実チューナーが無いので、NIT と SDT を組み立てて食わせる。
 * セクションがパケットをまたぐ場合も作って、繋ぎ直しを確かめる。
 */

/** セクション本体に CRC32 を付ける。section_length も実長に直す */
function withCrc(body: number[]): Uint8Array {
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

function stream(): Uint8Array {
    const nit = packetize(0x0010, nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]));
    const sdt = packetize(
        0x0011,
        sdtSection(0x0408, 0x0004, [
            [1024, 0x01],
            [2048, 0xc1],
        ]),
        3,
    );
    return Uint8Array.from([...nit, ...sdt]);
}

describe('セクションの解釈', () => {
    test('SDT からサービスを読む', () => {
        const parsed = parseSdt(
            sdtSection(0x0408, 0x0004, [
                [1024, 0x01],
                [1025, 0x01],
            ]),
        );
        expect(parsed?.transportStreamId).toBe(0x0408);
        expect(parsed?.originalNetworkId).toBe(0x0004);
        expect(parsed?.services).toEqual([
            { serviceId: 1024, serviceType: 0x01 },
            { serviceId: 1025, serviceType: 0x01 },
        ]);
    });

    test('NIT からネットワークIDとリモコン番号を読む', () => {
        const parsed = parseNit(nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]));
        expect(parsed?.networkId).toBe(0x7fe0);
        expect(parsed?.remoteControlKeyId).toBe(6);
        expect(parsed?.transportStreams[0].transportStreamId).toBe(0x0408);
        expect(parsed?.transportStreams[0].services[0].serviceId).toBe(1024);
    });

    test('CRCが合わないセクションは捨てる', () => {
        const section = sdtSection(0x0408, 0x0004, [[1024, 0x01]]);
        section[section.length - 1] ^= 0xff;
        const reader = new ServiceReader();
        reader.feed(packetize(0x0011, section));
        expect(reader.transport).toBeNull();
    });
});

describe('サービスの読み取り', () => {
    test('NIT と SDT が揃うまで待つ', () => {
        const reader = new ServiceReader();
        expect(
            reader.feed(packetize(0x0010, nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]))),
        ).toBe(false);
        expect(reader.services()).toEqual([]);
        expect(reader.feed(packetize(0x0011, sdtSection(0x0408, 0x0004, [[1024, 0x01]])))).toBe(true);
    });

    test('録れない種別は混ぜない', () => {
        const reader = new ServiceReader();
        reader.feed(stream());
        // 0xC1 は蓄積型サービス。Mirakurun のスキャンが通す種別に入っていない
        expect(reader.services().map((s) => s.serviceId)).toEqual([1024]);
    });

    test('ネットワークIDとリモコン番号を配る', () => {
        const reader = new ServiceReader();
        reader.feed(stream());
        expect(reader.services()[0]).toMatchObject({
            networkId: 0x7fe0,
            transportStreamId: 0x0408,
            remoteControlKeyId: 6,
        });
    });

    test('パケットをまたぐセクションを繋ぎ直す', () => {
        const reader = new ServiceReader();
        const many: [number, number][] = Array.from({ length: 40 }, (_, i) => [1024 + i, 0x01]);
        reader.feed(packetize(0x0010, nitSection(0x7fe0, 6, [[0x0408, 0x0004, many]])));
        reader.feed(packetize(0x0011, sdtSection(0x0408, 0x0004, many)));
        expect(reader.complete).toBe(true);
        expect(reader.services()).toHaveLength(40);
    });

    test('188の切れ目と無関係に届いても読める', () => {
        const reader = new ServiceReader();
        const data = stream();
        for (let at = 0; at < data.length; at += 100) reader.feed(data.subarray(at, at + 100));
        expect(reader.complete).toBe(true);
        expect(reader.services().map((s) => s.serviceId)).toEqual([1024]);
    });

    test('別のPIDは読まない', () => {
        const reader = new ServiceReader();
        reader.feed(packetize(0x0100, sdtSection(0x0408, 0x0004, [[1024, 0x01]])));
        expect(reader.transport).toBeNull();
    });
});
