/**
 * 見つかっているチャンネルの控え。
 *
 * mirakc の `config.yml` の `channels:` に当たるもの。あちらはコメントごと
 * 残すために段落だけを差し替えるという面倒をしていたが、**チューナーの定義と
 * 分けてしまえば済む話**だった。こちらは丸ごと書き直してよい。
 *
 * - `tuners.yml` … 繋いである機材。**人が書き、こちらは読むだけ**
 * - `channels.json` … スキャンで分かったこと。**こちらが書く**
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FoundService } from '../src/lib/ts/psi';
import type { TunerSpec } from './tuners';

export type ChannelType = 'GR' | 'BS' | 'CS';

export interface ChannelService {
    serviceId: number;
    serviceType: number;
    name: string;
}

export interface ChannelEntry {
    type: ChannelType;
    /** 選局に使う名前 (`T27` / `BS15_0` / `CS24`) */
    channel: string;
    networkId: number;
    transportStreamId: number;
    /** 地上波のリモコン番号。衛星には無い */
    remoteControlKeyId: number | null;
    services: ChannelService[];
}

const CHANNELS = process.env.CHANNELS_FILE ?? '/app-config/channels.json';
const TUNERS = process.env.TUNERS_FILE ?? '/app-config/tuners.yml';

/** 並べ替えの順。種別ごとにまとまっているほうが読みやすい */
const TYPE_ORDER: Record<string, number> = { GR: 0, BS: 1, CS: 2 };

export function loadChannels(): ChannelEntry[] {
    try {
        const parsed = JSON.parse(readFileSync(CHANNELS, 'utf8')) as ChannelEntry[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        // まだ1度もスキャンしていない。空でよい (画面が「まだありません」と出す)
        return [];
    }
}

/**
 * 見つけたチャンネルだけ差し替える。
 *
 * **探した種別だけ**を入れ替え、他はそのまま残す。地上波だけスキャンしたときに
 * 全部を置き換えると、BS と CS が設定から消える (実際に消して、BSの予約が
 * 録れなくなった)。
 */
export function saveChannels(found: ChannelEntry[], scanned: ChannelType[]): ChannelEntry[] {
    const kept = loadChannels().filter((channel) => !scanned.includes(channel.type));
    const merged = [...kept, ...found].sort(
        (a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.channel.localeCompare(b.channel),
    );

    mkdirSync(dirname(CHANNELS), { recursive: true });
    // 書きかけを読ませない。読む側 (denpa) は起動中にも取りに来る
    const working = `${CHANNELS}.writing`;
    writeFileSync(working, JSON.stringify(merged, null, 4));
    renameSync(working, CHANNELS);
    return merged;
}

/** スキャンで分かったことを1件にまとめる */
export function channelEntry(type: ChannelType, channel: string, services: FoundService[]): ChannelEntry {
    const first = services[0];
    return {
        type,
        channel,
        networkId: first?.networkId ?? 0,
        transportStreamId: first?.transportStreamId ?? 0,
        remoteControlKeyId: first?.remoteControlKeyId ?? null,
        services: services
            .map((service) => ({
                serviceId: service.serviceId,
                serviceType: service.serviceType,
                name: service.name,
            }))
            .sort((a, b) => a.serviceId - b.serviceId),
    };
}

/**
 * 繋いである機材。**ここは読むだけ。**
 *
 * スキャンで分かるものではないので、書き換える口も持たない。
 * ファイルが無ければ空を返す — チューナーが1本も無いことは異常だが、
 * 起動できないよりは画面に「チューナーがありません」と出したほうがいい。
 */
export function loadTuners(): TunerSpec[] {
    if (!existsSync(TUNERS)) return [];
    try {
        const parsed = Bun.YAML.parse(readFileSync(TUNERS, 'utf8')) as { tuners?: TunerSpec[] } | null;
        return parsed?.tuners ?? [];
    } catch (error) {
        console.error(`[agent] ${TUNERS} を読めません: ${error}`);
        return [];
    }
}

export const paths = { channels: CHANNELS, tuners: TUNERS };
