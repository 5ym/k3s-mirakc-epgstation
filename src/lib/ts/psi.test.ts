import { describe, expect, test } from 'bun:test';
import { PsiTap, parseNit, parseSdt, ServiceReader } from './psi';
import { nitSection, packetize, patSection, pmtSection, sdtSection } from './synth';

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

/**
 * 呼び水。**次に開くときのために PAT と PMT を取っておく。**
 *
 * ffmpeg は入口で PAT と PMT を待つので、選局を待っている間に先に流して
 * おける。半端なものを流しても意味が無いので、揃うまでは出さない。
 */
describe('呼び水 (PsiTap)', () => {
    const PAT = packetize(
        0x0000,
        patSection([
            [1024, 0x01f0],
            [1025, 0x01f1],
        ]),
    );
    const PMT1 = packetize(0x01f0, pmtSection(1024, 0x0100, 0x00), 3);
    const PMT2 = packetize(0x01f1, pmtSection(1025, 0x0110, 0x00), 5);

    test('PAT だけでは揃わない', () => {
        const tap = new PsiTap();
        tap.feed(PAT);
        expect(tap.full).toBe(false);
        expect(tap.primer()).toBeNull();
    });

    /** PAT に2局居るなら、PMT も2本ぶん要る。1本で出すと片方が引けない */
    test('PAT が名乗った PMT が全部そろって初めて出す', () => {
        const tap = new PsiTap();
        tap.feed(PAT);
        tap.feed(PMT1);
        expect(tap.full).toBe(false);
        tap.feed(PMT2);
        expect(tap.full).toBe(true);

        const primer = tap.primer()!;
        expect(primer.length).toBe(PAT.length + PMT1.length + PMT2.length);
        // 拾ったものをそのまま並べる。作り直さない
        expect(primer.subarray(0, PAT.length)).toEqual(PAT);
    });

    /** PMT より先に来ることもある。PAT を読むまでどの PID が要るか分からない */
    test('PAT より先に来た PMT は拾わない', () => {
        const tap = new PsiTap();
        tap.feed(PMT1);
        tap.feed(PAT);
        tap.feed(PMT2);
        // PMT1 を取りこぼしているので、まだ揃っていない
        expect(tap.full).toBe(false);
        tap.feed(PMT1);
        expect(tap.full).toBe(true);
    });

    /** 揃ったら止める。PSI は流れ続けるが、拾い直す値打ちは無い */
    test('揃ったあとは太らない', () => {
        const tap = new PsiTap();
        tap.feed(Uint8Array.from([...PAT, ...PMT1, ...PMT2]));
        const size = tap.primer()!.length;
        for (let i = 0; i < 20; i++) tap.feed(Uint8Array.from([...PAT, ...PMT1, ...PMT2]));
        expect(tap.primer()!.length).toBe(size);
    });
});
