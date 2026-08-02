import { describe, expect, test } from 'bun:test';
import { parseNit, parseSdt, ServiceReader } from './psi';
import { nitSection, packetize, sdtSection } from './synth';

/**
 * 実チューナーが無いので、NIT と SDT を組み立てて食わせる。
 * セクションがパケットをまたぐ場合も作って、繋ぎ直しを確かめる。
 */

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
