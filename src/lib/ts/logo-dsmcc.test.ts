import { describe, expect, test } from 'bun:test';
import { LogoCollector } from './logo';
import { DsmccLogoCollector, parseLogoModule } from './logo-dsmcc';
import { ddbSection, diiSection, logoModule, packetize, patSection, pmtSection } from './synth';

/**
 * 衛星 (BS/CS) のロゴ。
 *
 * 地上波と違って CDT には載らず、データカルーセル (DSM-CC) で流れてくる。
 * PAT → エンジニアリングサービス (929) の PMT → component_tag 0x79/0x7A の ES
 * → DII でモジュールの大きさ → DDB でブロック、と辿らないと拾えない。
 */

/** 1x1 の PNG のつもり。中身は問わない */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbe, 0xef]);

const ESS = 929;
const PMT_PID = 0x1f0;
const ES_PID = 0x1f1;
const DOWNLOAD_ID = 0x12345678;
const MODULE_ID = 0x0001;

function stream(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/** カルーセル一式。モジュールを `blockSize` ごとに割って DDB に載せる */
function carousel(module: Uint8Array, blockSize: number, name = 'LOGO-05'): Uint8Array {
    const blocks: Uint8Array[] = [];
    for (let at = 0, n = 0; at < module.length; at += blockSize, n++) {
        blocks.push(
            packetize(ES_PID, ddbSection(DOWNLOAD_ID, MODULE_ID, 1, n, module.subarray(at, at + blockSize))),
        );
    }
    return stream(
        packetize(0x0000, patSection([[ESS, PMT_PID]])),
        packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
        packetize(
            ES_PID,
            diiSection(DOWNLOAD_ID, blockSize, {
                moduleId: MODULE_ID,
                moduleSize: module.length,
                moduleVersion: 1,
                name,
            }),
        ),
        ...blocks,
    );
}

describe('parseLogoModule', () => {
    test('ロゴと、それを使う局を読む', () => {
        const logos = parseLogoModule(
            logoModule(0x05, [
                {
                    logoId: 0x0011,
                    services: [
                        [4, 211],
                        [4, 212],
                    ],
                    data: PNG,
                },
            ]),
        );
        expect(logos).toHaveLength(1);
        expect(logos[0].logoId).toBe(0x0011);
        expect(logos[0].logoType).toBe(0x05);
        // **どの局のロゴかはモジュール自身が持っている。** 地上波と違って SDT を待たない
        expect(logos[0].services).toEqual([
            { networkId: 4, serviceId: 211 },
            { networkId: 4, serviceId: 212 },
        ]);
        /*
         * 中身はそのまま出てくる。地上波と同じく色の表を入れ直して返すが
         * (`withPalette`)、形が違うものは触らない決まりなので、この偽 PNG は
         * 素通りする。入れ直しそのものは logo-palette 側で見ている
         */
        expect(logos[0].data).toEqual(PNG);
    });

    test('途中で切れていても、読めたぶんだけ返す', () => {
        const module = logoModule(0x05, [{ logoId: 1, services: [[4, 211]], data: PNG }]);
        expect(parseLogoModule(module.subarray(0, module.length - 4))).toEqual([]);
    });
});

describe('DsmccLogoCollector', () => {
    test('PAT から辿ってカルーセルを組み立てる', () => {
        const collector = new DsmccLogoCollector();
        const module = logoModule(0x05, [{ logoId: 0x0011, services: [[4, 211]], data: PNG }]);
        // わざと小さく割る。1つの DDB に収まると組み立てを試したことにならない
        for (const packet of packets(carousel(module, 16))) collector.feed(packet);

        const logos = collector.collected();
        expect(logos).toHaveLength(1);
        expect(logos[0].services).toEqual([{ networkId: 4, serviceId: 211 }]);
    });

    test('名前の違うモジュールは拾わない', () => {
        const collector = new DsmccLogoCollector();
        const module = logoModule(0x05, [{ logoId: 1, services: [[4, 211]], data: PNG }]);
        // カルーセルにはロゴ以外のモジュールも流れている
        for (const packet of packets(carousel(module, 16, 'BOARD-1'))) collector.feed(packet);
        expect(collector.collected()).toEqual([]);
    });

    test('CS の component_tag でも拾う', () => {
        const collector = new DsmccLogoCollector();
        const module = logoModule(0x05, [{ logoId: 2, services: [[7, 330]], data: PNG }]);
        const data = stream(
            packetize(0x0000, patSection([[ESS, PMT_PID]])),
            packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x7a)),
            packetize(
                ES_PID,
                diiSection(DOWNLOAD_ID, 4066, {
                    moduleId: MODULE_ID,
                    moduleSize: module.length,
                    moduleVersion: 1,
                    name: 'CS_LOGO-05',
                }),
            ),
            packetize(ES_PID, ddbSection(DOWNLOAD_ID, MODULE_ID, 1, 0, module)),
        );
        for (const packet of packets(data)) collector.feed(packet);
        expect(collector.collected()[0]?.services).toEqual([{ networkId: 7, serviceId: 330 }]);
    });

    /**
     * **CS のロゴは BS の中継から流れてくる。**
     *
     * 実機の `BS15_0` を15分読み続けると、エンジニアリングサービスに
     * `LOGO-00`〜`LOGO-05` と `CS_LOGO-00`〜`CS_LOGO-05` が並んで来ていた
     * (CS の12中継にはエンジニアリングサービスが1つも居ない)。
     *
     * DII のモジュールを1つ見つけた時点で打ち切っていた頃は、先に並んでいる
     * BS のぶんしか組み立てず、CS が永久に揃わなかった。
     */
    test('1つのカルーセルに並んだ BS と CS のモジュールを両方組み立てる', () => {
        const collector = new DsmccLogoCollector();
        const bs = logoModule(0x05, [{ logoId: 0x0011, services: [[4, 211]], data: PNG }]);
        // logo_id は BS と CS で別々に振られていて、同じ番号が普通に出てくる
        const cs = logoModule(0x05, [{ logoId: 0x0011, services: [[7, 330]], data: PNG }]);
        const CS_MODULE_ID = MODULE_ID + 1;
        const data = stream(
            packetize(0x0000, patSection([[ESS, PMT_PID]])),
            packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
            packetize(
                ES_PID,
                diiSection(DOWNLOAD_ID, 4066, [
                    { moduleId: MODULE_ID, moduleSize: bs.length, moduleVersion: 1, name: 'LOGO-05' },
                    {
                        moduleId: CS_MODULE_ID,
                        moduleSize: cs.length,
                        moduleVersion: 1,
                        name: 'CS_LOGO-05',
                    },
                ]),
            ),
            packetize(ES_PID, ddbSection(DOWNLOAD_ID, MODULE_ID, 1, 0, bs)),
            packetize(ES_PID, ddbSection(DOWNLOAD_ID, CS_MODULE_ID, 1, 0, cs)),
        );
        for (const packet of packets(data)) collector.feed(packet);

        // 同じ logo_id でも上書きし合わないこと
        const found = collector.collected();
        expect(found).toHaveLength(2);
        expect(found.flatMap((logo) => logo.services)).toEqual([
            { networkId: 4, serviceId: 211 },
            { networkId: 7, serviceId: 330 },
        ]);
    });
});

describe('LogoCollector (衛星)', () => {
    test('ネットワークごとにまとめて返す', () => {
        // 1つのロゴが他ネットワークの局にも紐付いていることがある
        const module = logoModule(0x05, [
            {
                logoId: 3,
                services: [
                    [4, 211],
                    [6, 800],
                ],
                data: PNG,
            },
        ]);
        const collector = new LogoCollector(4);
        collector.feed(carousel(module, 4066));

        const found = collector.collected();
        expect(found).toHaveLength(2);
        expect(found.map((f) => [f.networkId, f.serviceIds])).toEqual([
            [4, [211]],
            [6, [800]],
        ]);
    });
});

/** 188 バイトずつに切り分ける。`DsmccLogoCollector` はパケット単位で食べる */
function* packets(data: Uint8Array): Generator<Uint8Array> {
    for (let at = 0; at + 188 <= data.length; at += 188) yield data.subarray(at, at + 188);
}
