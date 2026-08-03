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
                [1024, 0x01, 'TOKYO MX1'],
                [1025, 0x01],
            ]),
        );
        expect(parsed?.transportStreamId).toBe(0x0408);
        expect(parsed?.originalNetworkId).toBe(0x0004);
        expect(parsed?.services).toEqual([
            // 局名は SDT にしか無い。番組表の列見出しはこれで決まる
            { serviceId: 1024, serviceType: 0x01, name: 'TOKYO MX1' },
            { serviceId: 1025, serviceType: 0x01, name: '' },
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

/**
 * 電波が弱いと途中でバイトが落ちる。1バイトずれただけで以降ずっと
 * 1パケットも読めなくなると、受信できているのに「局が居ない」ことになる。
 */
describe('同期の取り直し', () => {
    /** 実際のチューナーと同じで、同じ表が何度も流れてくる状況にする */
    function repeated(times = 4): Uint8Array {
        const parts: number[] = [];
        for (let i = 0; i < times; i++) parts.push(...stream());
        return Uint8Array.from(parts);
    }

    test('頭がずれていても読める', () => {
        const body = repeated();
        // わざと 0x47 で埋める。頭が1つ合っただけでは切れ目とは言えない
        const data = new Uint8Array(37 + body.length);
        data.fill(0x47, 0, 37);
        data.set(body, 37);

        const reader = new ServiceReader();
        reader.feed(data);
        expect(reader.complete).toBe(true);
    });

    test('途中で落ちても後ろを読める', () => {
        const data = repeated();
        // 頭の NIT の直後で 3 バイト落とす。以降の切れ目が 188 の倍数から外れる
        const broken = Uint8Array.from([...data.subarray(0, 188), ...data.subarray(191)]);
        const reader = new ServiceReader();
        reader.feed(broken);
        expect(reader.transport).not.toBeNull();
    });

    test('同期が取れなくても溜め込まない', () => {
        const reader = new ServiceReader();
        for (let i = 0; i < 50; i++) reader.feed(new Uint8Array(4096).fill(0x00));
        reader.feed(repeated());
        expect(reader.complete).toBe(true);
    });
});
