/**
 * 見つかっているチャンネルの控え。
 *
 * mirakc の `config.yml` の `channels:` に当たるもの。あちらはコメントごと
 * 残すために段落だけを差し替えるという面倒をしていたが、**チューナーの定義と
 * 分けてしまえば済む話**だった。こちらは丸ごと書き直してよい。
 *
 * - `tuners.json` … 繋いである機材。**denpa の画面が書き換える**
 * - `channels.json` … スキャンで分かったこと。**denpa が預けてくる**
 *
 * 中身を作るのはこちらではない。総当たりの選局こそ頼まれるが、NIT も SDT も
 * 解かないので「何が居たか」は分からない。読むのは denpa
 * ([roadmap.md](../docs/roadmap.md))。それでも控えを持つのはこちら側にする —
 * アンテナに何が映るかは機材ごとの話だから。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
const TUNERS = process.env.TUNERS_FILE ?? '/app-config/tuners.json';
const RECISDB = process.env.RECISDB ?? 'recisdb';

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

/**
 * 繋いである機材。**画面から書き換えられる。**
 *
 * ファイルが無ければ空を返す — チューナーが1本も無いことは異常だが、
 * 起動できないよりは画面に「チューナーがありません」と出したほうがいい
 * (.NET 版はここで自分で探しにいく)。
 */
export function loadTuners(): TunerSpec[] {
    if (!existsSync(TUNERS)) return [];
    try {
        const parsed = JSON.parse(readFileSync(TUNERS, 'utf8')) as { tuners?: TunerSpec[] } | null;
        return Array.isArray(parsed?.tuners) ? parsed.tuners.filter((t) => typeof t?.name === 'string') : [];
    } catch (error) {
        console.error(`[agent] ${TUNERS} を読めません: ${error}`);
        return [];
    }
}

/**
 * 画面から預かった機材で置き換える。
 *
 * **空を渡すと定義そのものを消す。** 「1本も無い」を書き込めるようにして
 * おくより、無い状態=何も掴めない、のほうが後で困らない。
 */
export function saveTuners(tuners: TunerSpec[]): void {
    if (tuners.length === 0) {
        if (existsSync(TUNERS)) rmSync(TUNERS);
        return;
    }
    mkdirSync(dirname(TUNERS), { recursive: true });
    const working = `${TUNERS}.writing`;
    writeFileSync(working, JSON.stringify({ tuners }, null, 4));
    renameSync(working, TUNERS);
}

/**
 * 選局に使う実際のコマンド。
 *
 * **デバイスと種別から組み立てる。** 自由な文字列を画面から受けると
 * 「denpa に入れた人がチューナー側で好きなコマンドを走らせられる」ことに
 * なる (しかもあちらは privileged)。`command` はファイルに直に書いたときの
 * 逃げ道で、画面からは触らせない。
 */
export function resolveCommand(tuner: TunerSpec): string {
    if (typeof tuner.command === 'string' && tuner.command !== '') return tuner.command;
    const lnb = tuner.lnb === undefined || tuner.lnb === '' ? '' : ` --lnb ${tuner.lnb}`;
    return `${RECISDB} tune --device ${tuner.device} --channel {{channel}}${lnb} -`;
}

export const paths = { channels: CHANNELS, tuners: TUNERS };
