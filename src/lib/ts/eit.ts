/**
 * EIT を読む。番組表の中身そのもの。
 *
 * **denpa が自分で読む。** 番組表を誰かに聞きに行かないので、**チューナーが
 * 空いているだけ並列に回せる**し、録画で開いているチャンネルのぶんはただで
 * 手に入る ([agent.md](../../../docs/agent.md))。
 *
 * 扱うのは2種類。
 *
 * - **EIT[p/f]** (table_id 0x4E) … いま流れている番組と次の番組。**放送に追従する。**
 *   野球で延びた終了時刻はここに出る
 * - **EIT[schedule]** (table_id 0x50〜0x5F) … 数日先までの番組表
 *
 * どちらも PID 0x0012 に流れてくる。
 */

import type { Genre } from '../arib';
import { decodeAribText } from './aribtext';
import { descriptors, PacketStream, SectionAssembler } from './psi';

export const PID_EIT = 0x0012;

const TABLE_PF_ACTUAL = 0x4e;
const SCHEDULE_ACTUAL_MIN = 0x50;
/** 詳細 (extended) の表はここから。基本と同じ並びがもう一度始まる */
const SCHEDULE_ACTUAL_EXTENDED = 0x58;
const SCHEDULE_ACTUAL_MAX = 0x5f;

/** セグメント1つが受け持つ時間。0:00 から3時間ずつ、1日8つ */
const SEGMENT_SPAN = 3 * 3600_000;
/** 1つの table_id が持つセグメントの数 (= 4日ぶん) */
const SEGMENTS_PER_TABLE = 32;

const DESC_SHORT_EVENT = 0x4d;
const DESC_EXTENDED_EVENT = 0x4e;
const DESC_COMPONENT = 0x50;
const DESC_CONTENT = 0x54;
const DESC_AUDIO_COMPONENT = 0xc4;

/** 自局のものだけ扱う。他局の番組表 (0x4F / 0x60〜0x6F) は選局し直せば取れる */
export function isEitActual(tableId: number): boolean {
    return tableId === TABLE_PF_ACTUAL || (tableId >= SCHEDULE_ACTUAL_MIN && tableId <= SCHEDULE_ACTUAL_MAX);
}

export interface EventAudio {
    componentType: number;
    langs: string[];
    samplingRate?: number;
    /**
     * 放送が自分で付けた名前。**「主音声ステレオ」「解説ステレオ」。**
     *
     * 同じ構成の音声が2本ある番組 (解説放送・二重音声) は、種別も言語も同じに
     * なるので**符号からは区別が付かない**。実機の日テレでは、どちらも
     * `component_type=3 lang=jpn` で「ステレオ (日本語)」が2つ並んでいた。
     * 見分けが付くものはここにしか無い
     */
    text?: string;
    /** 主音声か (`main_component_flag`)。**解説放送はこちらが立っていないほう** */
    main?: boolean;
}

export interface EitEvent {
    serviceId: number;
    transportStreamId: number;
    originalNetworkId: number;
    eventId: number;
    /** 開始時刻 (epoch ms)。未定 (全ビット1) なら null */
    startAt: number | null;
    /** 尺 (ms)。未定なら null。番組表に入れられるのは決まっているものだけ */
    duration: number | null;
    isFree: boolean;
    /** 1=まもなく 2=停止中 3=一時停止 4=放送中。p/f の「いま」を見分けるのに使う */
    runningStatus: number;
    name: string;
    description: string;
    /** 「出演者」などの見出し付き。extended_event_descriptor を繋ぎ直したもの */
    extended: Record<string, string>;
    genres: Genre[];
    audios: EventAudio[];
    video: { type: string | null; resolution: string | null } | null;
}

export interface EitSection {
    tableId: number;
    serviceId: number;
    transportStreamId: number;
    originalNetworkId: number;
    version: number;
    sectionNumber: number;
    lastSectionNumber: number;
    /** このセグメント (8セクション単位) で実際に使われている最後のセクション */
    segmentLastSectionNumber: number;
    /** この局で使われている最後の table_id。番組表がどこまで先を持っているか */
    lastTableId: number;
    events: EitEvent[];
}

/** MJD (修正ユリウス日) の基準。1970-01-01 が 40587 */
const MJD_EPOCH = 40587;
/** 放送の時刻は日本時間で書かれている */
const JST_OFFSET = 9 * 3600;

const bcd = (byte: number) => (byte >> 4) * 10 + (byte & 0x0f);

/**
 * MJD + BCD の5バイトを epoch ms に直す。
 *
 * 全ビットが1なら「未定」。開始時刻が未定の番組は番組表に置けないので null で返す。
 */
export function parseMjdTime(data: Uint8Array, at: number): number | null {
    let allOnes = true;
    for (let i = 0; i < 5; i++) {
        if (data[at + i] !== 0xff) allOnes = false;
    }
    if (allOnes) return null;

    const mjd = (data[at] << 8) | data[at + 1];
    const seconds =
        (mjd - MJD_EPOCH) * 86400 +
        bcd(data[at + 2]) * 3600 +
        bcd(data[at + 3]) * 60 +
        bcd(data[at + 4]) -
        JST_OFFSET;
    return seconds * 1000;
}

/** BCD 3バイトの尺 (時分秒) を ms に。全ビット1なら「終了未定」 */
export function parseBcdDuration(data: Uint8Array, at: number): number | null {
    if (data[at] === 0xff && data[at + 1] === 0xff && data[at + 2] === 0xff) return null;
    return (bcd(data[at]) * 3600 + bcd(data[at + 1]) * 60 + bcd(data[at + 2])) * 1000;
}

/**
 * 映像の解像度。component_type の上位ニブルで決まる。
 *
 * 480i だけ 0x01〜0x04 と例外で、そこから先は 0xA?=480p, 0xB?=1080i … と並ぶ。
 * 画面の `videoLabel` がこの文字列をそのまま読む。
 */
const RESOLUTION: Record<number, string> = {
    0: '480i',
    8: '4320p',
    9: '2160p',
    10: '480p',
    11: '1080i',
    12: '720p',
    13: '240p',
    14: '1080p',
    15: '180p',
};

/** stream_content。1=MPEG-2, 5=H.264, 9=H.265 */
const VIDEO_CODEC: Record<number, string> = { 1: 'mpeg2', 5: 'h.264', 9: 'h.265' };

/** audio_component_descriptor の sampling_rate。3ビットの符号 */
const SAMPLING_RATE: Record<number, number> = { 1: 16000, 2: 22050, 3: 24000, 5: 32000, 6: 44100, 7: 48000 };

const lang = (data: Uint8Array, at: number) =>
    String.fromCharCode(data[at], data[at + 1], data[at + 2]).toLowerCase();

/**
 * 記述子を読んで番組の中身を埋める。
 *
 * **extended_event は分割して送られてくる。** descriptor_number 順に並んだものを
 * 見出しごとに繋ぎ直さないと、長い説明が途中で切れる。見出しが空の項目は
 * 「直前の項目の続き」という意味なので、そこにも繋ぐ。
 */
function readDescriptors(event: EitEvent, body: Uint8Array): void {
    /** 見出しの出てきた順。Map は挿入順を保つので、そのまま出せる */
    const items = event.extended;
    let lastHeading = '';

    for (const [tag, data] of descriptors(body)) {
        switch (tag) {
            case DESC_SHORT_EVENT: {
                const nameLength = data[3];
                const textAt = 4 + nameLength;
                event.name = decodeAribText(data.subarray(4, textAt));
                const textLength = data[textAt];
                event.description = decodeAribText(data.subarray(textAt + 1, textAt + 1 + textLength));
                break;
            }
            case DESC_EXTENDED_EVENT: {
                let at = 5;
                const itemsEnd = 5 + data[4];
                while (at < itemsEnd && at < data.length) {
                    const headingLength = data[at];
                    const heading = decodeAribText(data.subarray(at + 1, at + 1 + headingLength));
                    at += 1 + headingLength;
                    const textLength = data[at];
                    const text = decodeAribText(data.subarray(at + 1, at + 1 + textLength));
                    at += 1 + textLength;

                    // 見出しが空なら前の項目の続き。改行を挟まずそのまま繋ぐ
                    const key = heading === '' ? lastHeading : heading;
                    if (key === '') continue;
                    items[key] = (items[key] ?? '') + text;
                    lastHeading = key;
                }
                break;
            }
            case DESC_CONTENT: {
                for (let at = 0; at + 2 <= data.length; at += 2) {
                    event.genres.push({ lv1: data[at] >> 4, lv2: data[at] & 0x0f });
                }
                break;
            }
            case DESC_COMPONENT: {
                const streamContent = data[0] & 0x0f;
                const componentType = data[1];
                event.video = {
                    type: VIDEO_CODEC[streamContent] ?? null,
                    resolution:
                        RESOLUTION[componentType >> 4] ??
                        (componentType <= 0x04 ? RESOLUTION[0x0] : null) ??
                        null,
                };
                break;
            }
            /*
             * audio_component_descriptor (ARIB STD-B10 第2部)。
             *
             *     [0] reserved(4) stream_content(4)
             *     [1] component_type          … ステレオ・デュアルモノ…
             *     [2] component_tag
             *     [3] stream_type
             *     [4] simulcast_group_tag
             *     [5] 多言語(1) 主音声(1) 品質(2) 標本化周波数(3) reserved(1)
             *     [6..8]   ISO 639-2
             *     [9..11]  ISO 639-2 (多言語のときだけ)
             *     [残り]   text_char … **放送が付けた名前**
             */
            case DESC_AUDIO_COMPONENT: {
                const flags = data[5];
                const multiLingual = (flags & 0x80) !== 0;
                const langs = [lang(data, 6)];
                if (multiLingual) langs.push(lang(data, 9));
                const text = decodeAribText(data.subarray(6 + (multiLingual ? 6 : 3))).trim();
                event.audios.push({
                    componentType: data[1],
                    langs,
                    samplingRate: SAMPLING_RATE[(flags >> 1) & 0x07],
                    ...(text === '' ? {} : { text }),
                    main: (flags & 0x40) !== 0,
                });
                break;
            }
            default:
                break;
        }
    }
}

/**
 * EIT のセクションを1本読む。自局のもの以外は null。
 *
 * 壊れたセクションは `SectionAssembler` が CRC で落としているので、ここに来るのは
 * 中身が揃っているものだけ。それでも長さの辻褄が合わないことはあるので、
 * **読める番組まで返す**。
 */
export function parseEit(section: Uint8Array): EitSection | null {
    if (section.length < 18) return null;
    const tableId = section[0];
    if (!isEitActual(tableId)) return null;

    const result: EitSection = {
        tableId,
        serviceId: (section[3] << 8) | section[4],
        version: (section[5] >> 1) & 0x1f,
        sectionNumber: section[6],
        lastSectionNumber: section[7],
        transportStreamId: (section[8] << 8) | section[9],
        originalNetworkId: (section[10] << 8) | section[11],
        segmentLastSectionNumber: section[12],
        lastTableId: section[13],
        events: [],
    };

    let at = 14;
    const end = section.length - 4;
    while (at + 12 <= end) {
        const descriptorsLength = ((section[at + 10] & 0x0f) << 8) | section[at + 11];
        const body = section.subarray(at + 12, at + 12 + descriptorsLength);
        const event: EitEvent = {
            serviceId: result.serviceId,
            transportStreamId: result.transportStreamId,
            originalNetworkId: result.originalNetworkId,
            eventId: (section[at] << 8) | section[at + 1],
            startAt: parseMjdTime(section, at + 2),
            duration: parseBcdDuration(section, at + 7),
            runningStatus: (section[at + 10] >> 5) & 0x07,
            isFree: (section[at + 10] & 0x10) === 0,
            name: '',
            description: '',
            extended: {},
            genres: [],
            audios: [],
            video: null,
        };
        at += 12 + descriptorsLength;
        if (body.length < descriptorsLength) break;

        readDescriptors(event, body);
        result.events.push(event);
    }

    return result;
}

/**
 * どこまで集まったかを数える。
 *
 * **これが無いと「もう十分」が分からない。** 何分開いておくかを決め打ちにすると、
 * 早く揃った局でも待たされ、遅い局は取りこぼす。EIT は自分がどこまであるかを
 * セクションの中で言っているので、それを数えれば足りる。
 *
 * セクションは**8本ずつのセグメント**に分かれていて、セグメントの中で実際に
 * 使われている最後の番号が `segment_last_section_number`。使われていない番号は
 * 永久に来ないので、そこまで揃えばそのセグメントは終わり。
 *
 * **過ぎた時間帯のセグメントは流れてこない** (`stale`)。空でも先頭の1本は必ず
 * 来るものとして待っていた頃は、**どのチャンネルも例外なく上限まで
 * 開きっぱなし**になっていた (実機14チャンネル、揃って離せたのは0本)。
 */
export class ScheduleProgress {
    /** `table_id` → 受け取ったセクション番号 */
    private readonly seen = new Map<number, Set<number>>();
    /** `table_id:セグメント先頭` → そのセグメントの最後の番号 */
    private readonly segmentLast = new Map<string, number>();
    /** `table_id` → 最後のセクション番号 */
    private readonly lastSection = new Map<number, number>();
    private lastTableId = SCHEDULE_ACTUAL_MIN;
    /**
     * `table_id` → 版。変わったらその表だけ数え直す。
     *
     * **版は `table_id` ごとに別々に振られる。** 番組表の1つの表 (sub_table) は
     * `table_id` + 局 + TS で決まり、`version_number` はその単位で動く。
     * 局に1つだけ持っていた頃は、**基本 (0x50〜) と詳細 (0x58〜) を行き来する
     * たびに版が違って数えたものを全部捨てて**いた。揃ったと分かることが
     * 二度と無いので、どのチャンネルも1本5分の上限まで開きっぱなしになる。
     */
    private readonly version = new Map<number, number>();

    /**
     * @param now いまの時刻。過ぎた時間帯を判断するのに使う。
     *   時計を跨いで開いていることがあるので、値ではなく関数で受ける
     */
    constructor(private readonly now: () => number = Date.now) {}

    add(section: EitSection): void {
        // p/f は番組表の完成度とは関係ない (いつでも2番組しか無い)
        if (section.tableId < SCHEDULE_ACTUAL_MIN) return;
        if (section.version !== this.version.get(section.tableId)) {
            for (const key of [...this.segmentLast.keys()]) {
                if (key.startsWith(`${section.tableId}:`)) this.segmentLast.delete(key);
            }
            this.seen.delete(section.tableId);
            this.lastSection.delete(section.tableId);
            this.version.set(section.tableId, section.version);
        }

        const numbers = this.seen.get(section.tableId) ?? new Set<number>();
        numbers.add(section.sectionNumber);
        this.seen.set(section.tableId, numbers);
        this.segmentLast.set(
            `${section.tableId}:${section.sectionNumber & ~7}`,
            section.segmentLastSectionNumber,
        );
        this.lastSection.set(section.tableId, section.lastSectionNumber);
        this.lastTableId = Math.max(this.lastTableId, section.lastTableId);
    }

    /**
     * 使われている table_id を全部揃えられたか。
     *
     * **番号が飛ぶ。** 1つの `table_id` が受け持つのは4日ぶんで、基本は
     * `0x50` から、詳細は `0x58` から始まる。日本の放送は8日ぶんなので、
     * 実際に流れてくるのは `0x50` `0x51` と `0x58` `0x59` あたりだけで、
     * **`0x52`〜`0x57` は永久に来ません**。
     *
     * `0x50` から `last_table_id` まで全部を待っていた頃は、詳細を積んでいる局が
     * **一度も「揃った」にならず**、どのチャンネルも1本5分の上限まで開きっぱなしに
     * なっていました (実機で、詳細の無い BS11 だけが早く閉じていた)。
     *
     * 見かけた表と、`last_table_id` が指す表だけを見ます。
     */
    get complete(): boolean {
        if (this.seen.size === 0) return false;
        // いちばん後ろの表は必ず流れてくる。来ていないなら、まだ途中
        if (!this.seen.has(this.lastTableId)) return false;
        for (const tableId of this.seen.keys()) {
            if (!this.completeTable(tableId)) return false;
        }
        return true;
    }

    private completeTable(tableId: number): boolean {
        const numbers = this.seen.get(tableId);
        const last = this.lastSection.get(tableId);
        if (numbers === undefined || last === undefined) return false;

        for (let start = 0; start <= last; start += 8) {
            if (this.stale(tableId, start)) continue;
            const segmentLast = this.segmentLast.get(`${tableId}:${start}`);
            // セグメントの先頭すら来ていない。まだ待つ
            if (segmentLast === undefined) return false;
            for (let n = start; n <= segmentLast; n++) {
                if (!numbers.has(n)) return false;
            }
        }
        return true;
    }

    /**
     * そのセグメントの時間帯がもう過ぎているか。**過ぎたものは待たない。**
     *
     * セグメントは 0:00 から3時間ずつの枠で、`table_id` と節番号から
     * それがいつの枠なのかが決まる — 基本は `0x50` が当日 0:00 から4日ぶん、
     * `0x51` がその次の4日ぶん。詳細 (`0x58`〜) も同じ並びをもう一度たどる。
     *
     * **終わった枠は放送に乗らない。** 「空でも先頭の1本は来る」として
     * 待っていた頃は、実機で 0:00〜いまの枠がまるごと欠けたまま埋まらず、
     * **14チャンネル全部が上限の600秒を使い切って**いた。1つも早く離せず、
     * チューナーが常に番組表で埋まる。
     *
     * 過ぎた枠のぶんの番組は、そこが未来だった数日前に取り込んである。
     */
    private stale(tableId: number, start: number): boolean {
        const base = tableId < SCHEDULE_ACTUAL_EXTENDED ? SCHEDULE_ACTUAL_MIN : SCHEDULE_ACTUAL_EXTENDED;
        const segment = (tableId - base) * SEGMENTS_PER_TABLE + start / 8;
        const now = this.now();
        const offset = JST_OFFSET * 1000;
        const midnight = Math.floor((now + offset) / 86400_000) * 86400_000 - offset;
        return midnight + (segment + 1) * SEGMENT_SPAN <= now;
    }

    /**
     * 何が足りないか。**上限まで開いても揃わなかったときに出す。**
     *
     * 揃ったかどうかしか分からなかった頃は、上限まで開きっぱなしになっている局を
     * 見つけても**その先を追えなかった** — 電波が弱くて欠けているのか、
     * こちらが来ない表を待っているのかで、直し方がまるで違う。
     */
    report(): string {
        if (this.seen.size === 0) return 'EIT[schedule] が1つも来ていない';
        if (!this.seen.has(this.lastTableId)) {
            const seen = [...this.seen.keys()].map(hex).join(',');
            return `最後の表 ${hex(this.lastTableId)} が一度も来ない (来たのは ${seen})`;
        }

        const missing: string[] = [];
        for (const tableId of this.seen.keys()) {
            const numbers = this.seen.get(tableId) ?? new Set<number>();
            const last = this.lastSection.get(tableId) ?? 0;
            const holes: number[] = [];
            for (let start = 0; start <= last; start += 8) {
                // 待っていないものを「足りない」と言わない。数え方と揃える
                if (this.stale(tableId, start)) continue;
                const segmentLast = this.segmentLast.get(`${tableId}:${start}`);
                if (segmentLast === undefined) {
                    holes.push(start);
                    continue;
                }
                for (let n = start; n <= segmentLast; n++) if (!numbers.has(n)) holes.push(n);
            }
            if (holes.length > 0) {
                const head = holes.slice(0, 8).join(',');
                missing.push(
                    `${hex(tableId)} の ${head}${holes.length > 8 ? ` ほか${holes.length - 8}` : ''}`,
                );
            }
        }
        return missing.length === 0 ? '揃っている' : `来ていない節: ${missing.join(' / ')}`;
    }
}

const hex = (value: number) => `0x${value.toString(16)}`;

/**
 * 流れてくる TS を食べて番組を溜める。
 *
 * 局ごとに `ScheduleProgress` を持ち、**その物理チャンネルに乗っている局が
 * 全部揃ったら**読むのをやめられる。同じ番組が何度も来る (カルーセルなので) ので、
 * event_id で上書きしていく。
 */
export class EpgReader {
    private readonly sections = new SectionAssembler(PID_EIT);
    private readonly packets = new PacketStream();
    private readonly progress = new Map<number, ScheduleProgress>();
    /** `serviceId:eventId` → 番組。あとから来たもので上書きする */
    private readonly events = new Map<string, EitEvent>();

    /** p/f で「いま流れている」と言われた番組。録画の延長追従はこれを見る */
    readonly present = new Map<number, EitEvent>();

    /** @param now いまの時刻。局ごとの `ScheduleProgress` にそのまま渡す */
    constructor(private readonly now: () => number = Date.now) {}

    /** 任意の長さのバイト列を食わせる。番組が1つでも増えたら true */
    feed(chunk: Uint8Array): boolean {
        let added = false;
        for (const packet of this.packets.feed(chunk)) {
            for (const raw of this.sections.feed(packet)) {
                const section = parseEit(raw);
                if (section === null) continue;
                if (section.tableId >= SCHEDULE_ACTUAL_MIN) {
                    const progress = this.progress.get(section.serviceId) ?? new ScheduleProgress(this.now);
                    progress.add(section);
                    this.progress.set(section.serviceId, progress);
                }
                for (const event of section.events) {
                    if (section.tableId === TABLE_PF_ACTUAL && this.onAir(section, event)) {
                        this.present.set(event.serviceId, event);
                    }
                    if (event.startAt === null || event.duration === null) continue;
                    this.merge(event);
                    added = true;
                }
            }
        }
        return added;
    }

    /**
     * 溜めてあるものと混ぜる。**別の表で来るものを消し合わせない。**
     *
     * 番組表は2つの表に分かれて流れてくる。同じ event_id が両方に載っていて、
     * **それぞれ自分のぶんの記述子しか持っていない**。
     *
     * - **基本** (table_id 0x50〜0x57) … 題名と短い説明 (short_event_descriptor)
     * - **詳細** (0x58〜0x5F) … 「番組内容」「出演者」など (extended_event_descriptor)
     *
     * あとから来たもので丸ごと置き換えていた頃は、**詳細のほうが後に届いた番組の
     * 題名が空になっていた**。実機では番組 23,000 件のうち 11,000 件が名無しで、
     * うち 2,700 件は「題名は無いのに番組内容だけある」状態 — 詳細に上書きされた
     * 跡そのもの。番組表には「(番組情報なし)」の列が並んでいた。
     *
     * **中身のあるほうを残す。** 書き換え (「[新]」が付く、誤字が直る) は
     * 空でない値で来るので、これまでどおり新しいほうが勝つ。
     */
    private merge(event: EitEvent): void {
        const id = `${event.serviceId}:${event.eventId}`;
        const old = this.events.get(id);
        if (old === undefined) {
            this.events.set(id, event);
            return;
        }
        this.events.set(id, {
            ...event,
            name: event.name === '' ? old.name : event.name,
            description: event.description === '' ? old.description : event.description,
            extended: Object.keys(event.extended).length === 0 ? old.extended : event.extended,
            genres: event.genres.length === 0 ? old.genres : event.genres,
            audios: event.audios.length === 0 ? old.audios : event.audios,
            video: event.video ?? old.video,
        });
    }

    /**
     * p/f で「いま流れている」と言えるか。
     *
     * **`running_status` を当てにしきれない。** 4 (放送中) を入れてくる局も
     * あれば、**0 (未定義) しか入れてこない局もある** — 実機の NHK は 74 節
     * ぜんぶ 0 だった。4 だけを見ていると、そういう局では延長追従が丸ごと
     * 効かなくなる (docs/agent.md)。
     *
     * そこで 0 のときは**節の番号で決める**。p/f は仕様で
     * **section 0 が現在・section 1 が次**と決まっていて、こちらは局の都合で
     * 変わらない。1 (まもなく) や 2 (停止中) は今までどおり入れない。
     */
    private onAir(section: EitSection, event: EitEvent): boolean {
        if (event.runningStatus === 4) return true;
        return event.runningStatus === 0 && section.sectionNumber === 0;
    }

    /** 溜まった番組。開始時刻の順に並べて返す */
    all(): EitEvent[] {
        return [...this.events.values()].sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0));
    }

    /** 番組表を1つでも見かけた局 */
    services(): number[] {
        return [...this.progress.keys()];
    }

    /**
     * 見かけた局が**全部**揃ったか。
     *
     * 「1局でも揃えば閉じる」にはしない。1本の物理チャンネルには複数の局が
     * 乗っていて (地上波なら MX1 と MX2)、先に揃ったほうで閉じると残りが
     * 永久に埋まらない。
     */
    get complete(): boolean {
        if (this.progress.size === 0) return false;
        for (const progress of this.progress.values()) {
            if (!progress.complete) return false;
        }
        return true;
    }

    /**
     * 揃っていない局と、その理由。**上限まで開いてしまったときに出す。**
     *
     * 1局でも揃わなければチャンネルごと上限まで開き続けるので、
     * 「どの局のせいか」が分からないと直しようがない。
     */
    shortfall(): string[] {
        const out: string[] = [];
        for (const [serviceId, progress] of this.progress) {
            if (!progress.complete) out.push(`局 ${serviceId}: ${progress.report()}`);
        }
        return out;
    }
}
