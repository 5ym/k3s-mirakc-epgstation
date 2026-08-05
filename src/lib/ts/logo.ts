/**
 * 放送波から局ロゴを拾う。
 *
 * エージェントは TS を1バイトも読まないので、**番組表に出す局ロゴは denpa が
 * 自分で拾う**。録画やライブで開いているストリームから、ついでに読む。
 *
 * 地上波は2つの表に分かれて流れてくる。
 *
 * - CDT (PID 0x0029) … ロゴの実体。PNG がそのまま入っている
 * - SDT (PID 0x0011) … どのサービスがどのロゴを使うか (logo_transmission_descriptor)
 *
 * 片方だけでは紐付かないので、両方見て初めて「この局のロゴ」になる。
 *
 * **衛星 (BS/CS) は CDT を使わない。** データカルーセル (DSM-CC) で送るので、
 * そちらは別仕立て (`logo-dsmcc.ts`)。両方まとめてここで面倒を見る。
 */

import { DsmccLogoCollector } from './logo-dsmcc';
import { withPalette } from './logo-palette';
import { descriptors, PacketStream, SectionAssembler, sdtServices } from './psi';

const PID_CDT = 0x0029;
const PID_SDT = 0x0011;

const TABLE_CDT = 0xc8;
const TABLE_SDT_ACTUAL = 0x42;

const DATA_TYPE_LOGO = 0x01;
const DESC_LOGO_TRANSMISSION = 0xcf;

/**
 * 使うロゴの大きさ。0x05 が一番大きい(64×36)。
 * 小さいものは並べたときに粗いので、大きいものが来たら差し替える。
 */
const PREFERRED_LOGO_TYPE = 0x05;

export interface LogoData {
    logoId: number;
    logoType: number;
    logoVersion: number;
    /** そのまま画面に出せる PNG (色の表を入れ直したもの) */
    data: Uint8Array;
}

/**
 * CDT からロゴを読む。
 *
 * data_module_byte の中身 (ARIB STD-B21):
 *   logo_type 8 / reserved 7 + logo_id 9 / reserved 4 + logo_version 12 /
 *   data_size 16 / PNG
 *
 * PNG は色の表 (PLTE/tRNS) を抜いた形で流れてくるので、入れ直してから返す
 * (logo-palette.ts)。抜けたままだとブラウザは何も描かない。
 */
export function parseCdt(section: Uint8Array): LogoData | null {
    if (section[0] !== TABLE_CDT) return null;
    if (section[10] !== DATA_TYPE_LOGO) return null;

    const descriptorsLength = ((section[11] & 0x0f) << 8) | section[12];
    let at = 13 + descriptorsLength;
    const end = section.length - 4;
    if (at + 7 > end) return null;

    const logoType = section[at];
    const logoId = ((section[at + 1] & 0x01) << 8) | section[at + 2];
    const logoVersion = ((section[at + 3] & 0x0f) << 8) | section[at + 4];
    const size = (section[at + 5] << 8) | section[at + 6];
    at += 7;
    if (at + size > end) return null;

    return { logoId, logoType, logoVersion, data: withPalette(section.slice(at, at + size)) };
}

/**
 * SDT からサービスとロゴの対応を読む。
 *
 * logo_transmission_descriptor (0xCF) の 0x01/0x02 が「CDT で送る」形式。
 * 0x03 は文字で代用するもので、画像は流れてこない。
 */
export function parseLogoLinks(section: Uint8Array): Map<number, number> {
    const links = new Map<number, number>();
    if (section[0] !== TABLE_SDT_ACTUAL) return links;

    for (const [serviceId, body] of sdtServices(section)) {
        for (const [tag, descriptor] of descriptors(body)) {
            if (tag !== DESC_LOGO_TRANSMISSION || descriptor.length < 3) continue;
            const type = descriptor[0];
            if (type === 0x01 || type === 0x02) {
                links.set(serviceId, ((descriptor[1] & 0x01) << 8) | descriptor[2]);
            }
        }
    }
    return links;
}

export interface CollectedLogo {
    /**
     * その局のネットワーク。
     *
     * 衛星はロゴ自身が「どのネットワークのどの局か」を持っているので、開いた
     * チャンネルのものとは限らない (1つの中継に他ネットワークの局が乗る)。
     * 地上波は CDT にその情報が無いので、開いたチャンネルのものを使う。
     */
    networkId: number;
    serviceIds: number[];
    logo: LogoData;
}

/**
 * 流れてくる TS からロゴを拾い集める。
 *
 * 録画のストリームに相乗りするので、いつ揃うか分からないし、揃わないまま
 * 終わることもある。拾えたぶんだけ返す作りにしてある。
 */
export class LogoCollector {
    private readonly cdt = new SectionAssembler(PID_CDT);
    private readonly sdt = new SectionAssembler(PID_SDT);
    private readonly packets = new PacketStream();
    /** 衛星ぶん。地上波の TS では何も出てこないので、開いていても害は無い */
    private readonly dsmcc = new DsmccLogoCollector();

    /** logo_id ごとの、いま持っている一番大きいロゴ */
    private readonly logos = new Map<number, LogoData>();
    /** service_id → logo_id */
    private readonly links = new Map<number, number>();

    /**
     * @param networkId 開いている物理チャンネルのネットワーク。地上波の CDT には
     *   ネットワークが入っていないので、外から教えてもらう
     */
    constructor(private readonly networkId: number) {}

    /**
     * この中継にロゴのカルーセルが載っているか (衛星のみ)。
     * `false` なら、いくら開いても来ないので切り上げてよい
     */
    get hasSatelliteLogo(): boolean | null {
        return this.dsmcc.hasLogoService;
    }

    feed(chunk: Uint8Array): void {
        for (const packet of this.packets.feed(chunk)) {
            for (const section of this.cdt.feed(packet)) {
                const logo = parseCdt(section);
                if (logo !== null && logo.data.length > 0) this.remember(logo);
            }
            for (const section of this.sdt.feed(packet)) {
                for (const [serviceId, logoId] of parseLogoLinks(section)) {
                    this.links.set(serviceId, logoId);
                }
            }
            this.dsmcc.feed(packet);
        }
    }

    private remember(logo: LogoData): void {
        const known = this.logos.get(logo.logoId);
        // 大きいものを優先する。同じ大きさなら新しい版に入れ替える
        if (
            known === undefined ||
            (known.logoType !== PREFERRED_LOGO_TYPE && logo.logoType > known.logoType) ||
            (known.logoType === logo.logoType && logo.logoVersion !== known.logoVersion)
        ) {
            this.logos.set(logo.logoId, logo);
        }
    }

    /** 紐付いたぶんだけ返す。ロゴだけ・対応だけでは局に配れない */
    collected(): CollectedLogo[] {
        const byLogo = new Map<number, number[]>();
        for (const [serviceId, logoId] of this.links) {
            if (!this.logos.has(logoId)) continue;
            byLogo.set(logoId, [...(byLogo.get(logoId) ?? []), serviceId]);
        }
        const found: CollectedLogo[] = [...byLogo.entries()].map(([logoId, serviceIds]) => ({
            networkId: this.networkId,
            serviceIds,
            logo: this.logos.get(logoId)!,
        }));

        /*
         * 衛星ぶん。**ネットワークごとにまとめ直す。** 1つのロゴが他ネットワークの
         * 局にも紐付いていることがあるので、開いた中継のネットワークで一括りには
         * できない
         */
        for (const logo of this.dsmcc.collected()) {
            const byNetwork = new Map<number, number[]>();
            for (const service of logo.services) {
                byNetwork.set(service.networkId, [
                    ...(byNetwork.get(service.networkId) ?? []),
                    service.serviceId,
                ]);
            }
            for (const [networkId, serviceIds] of byNetwork) {
                found.push({
                    networkId,
                    serviceIds,
                    logo: {
                        logoId: logo.logoId,
                        logoType: logo.logoType,
                        logoVersion: 0,
                        data: logo.data,
                    },
                });
            }
        }
        return found;
    }
}
