/**
 * TS のセクションを組み立てる。
 *
 * 実チューナーが無いので、解析のテストにも偽エージェントにも「それらしい TS」が要る。
 * 読む側 (psi.ts / logo.ts) と対になる書く側で、ここだけが仕様の写し。
 */

import { PACKET, SYNC, withCrc } from './psi';

// 組み立てる側はここから取る人が多いので、そのまま出しておく
export { withCrc };

const be = (value: number) => [(value >> 8) & 0xff, value & 0xff];

/**
 * Unicode → JIS X 0208 の区点。**読む側の裏返し。**
 *
 * 表を抱え込まずに、EUC-JP のデコーダを1回だけ総当たりして作る
 * (84区 × 94点 = 7896 文字)。テストと偽放送局からしか呼ばないので、
 * 最初に使うときまで作らない。
 */
let jis: Map<string, number> | null = null;

function jisTable(): Map<string, number> {
    if (jis !== null) return jis;
    const decoder = new TextDecoder('euc-jp');
    jis = new Map();
    for (let ku = 0x21; ku <= 0x74; ku++) {
        for (let ten = 0x21; ten <= 0x7e; ten++) {
            const char = decoder.decode(Uint8Array.of(ku | 0x80, ten | 0x80));
            if (char.length !== 1 || char === '�') continue;
            if (!jis.has(char)) jis.set(char, (ku << 8) | ten);
        }
    }
    return jis;
}

/**
 * 文字列を ARIB STD-B24 の8単位符号にする。
 *
 * 初期状態 (G0=漢字) から始めて、ASCII のところだけ英数集合へ切り替える。
 * 本物の放送はもっと凝った切り替え方をするが、**読む側が同じ道を通れば足りる**。
 */
export function encodeAribText(text: string): number[] {
    const out: number[] = [];
    let alnum = false;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x80) {
            if (!alnum) out.push(0x1b, 0x28, 0x4a);
            alnum = true;
            out.push(code);
            continue;
        }
        if (alnum) out.push(0x1b, 0x24, 0x42);
        alnum = false;
        const kuten = jisTable().get(char);
        // 表に無い字は下駄で埋める (2区14点)。長さが変わらないので位置がずれない
        out.push(...be(kuten ?? 0x222e));
    }
    return out;
}

/** 長さ1バイトを頭に付けた文字列。SI の記述子はどこもこの形 */
const sized = (text: string) => {
    const body = encodeAribText(text);
    return [body.length, ...body];
};

export function sdtSection(
    transportStreamId: number,
    originalNetworkId: number,
    services: [number, number, string?][],
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
    for (const [serviceId, serviceType, name] of services) {
        // service_descriptor (0x48): 種別 + 事業者名 + サービス名
        const payload = [serviceType, 0x00, ...sized(name ?? '')];
        const descriptor = [0x48, payload.length, ...payload];
        body.push(...be(serviceId), 0xfc, ...be(0x8000 | descriptor.length), ...descriptor);
    }
    return withCrc(body);
}

/** epoch ms → MJD + BCD の5バイト。放送の時刻は日本時間で書く */
function mjdTime(at: number): number[] {
    const jst = Math.floor(at / 1000) + 9 * 3600;
    const mjd = Math.floor(jst / 86400) + 40587;
    const rest = ((jst % 86400) + 86400) % 86400;
    const bcd = (value: number) => ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;
    return [...be(mjd), bcd(Math.floor(rest / 3600)), bcd(Math.floor(rest / 60) % 60), bcd(rest % 60)];
}

/** ms → BCD 3バイトの尺 */
function bcdDuration(ms: number): number[] {
    const total = Math.floor(ms / 1000);
    const bcd = (value: number) => ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;
    return [bcd(Math.floor(total / 3600)), bcd(Math.floor(total / 60) % 60), bcd(total % 60)];
}

export interface SynthEvent {
    eventId: number;
    /** epoch ms */
    startAt: number;
    /** ms */
    duration: number;
    name: string;
    description?: string;
    extended?: Record<string, string>;
    genres?: [number, number][];
    /** 音声。並べたぶんだけ audio_component_descriptor を積む */
    audios?: SynthAudio[];
    /** component_descriptor の [stream_content, component_type] */
    video?: [number, number];
    isFree?: boolean;
    /** 4 = 放送中。EIT[p/f] で「いま」を表すのに使う */
    runningStatus?: number;
}

/** 音声1本ぶん。**放送が付けた名前まで持てる** (解説放送の見分けに要る) */
export interface SynthAudio {
    /** audio_component_descriptor の component_type (3 = ステレオ) */
    type: number;
    /** ISO 639-2。省くと jpn */
    lang?: string;
    /** 「主音声ステレオ」「解説ステレオ」。省くと名乗らない */
    text?: string;
    /** 主音声か。省くと主音声 */
    main?: boolean;
}

export interface EitOptions {
    tableId: number;
    serviceId: number;
    transportStreamId: number;
    originalNetworkId: number;
    version?: number;
    sectionNumber?: number;
    lastSectionNumber?: number;
    segmentLastSectionNumber?: number;
    lastTableId?: number;
    events: SynthEvent[];
}

function eventDescriptors(event: SynthEvent): number[] {
    const out: number[] = [];

    const short = [0x6a, 0x70, 0x6e, ...sized(event.name), ...sized(event.description ?? '')];
    out.push(0x4d, short.length, ...short);

    const extended = Object.entries(event.extended ?? {});
    if (extended.length > 0) {
        const items = extended.flatMap(([heading, text]) => [...sized(heading), ...sized(text)]);
        const body = [0x00, 0x6a, 0x70, 0x6e, items.length, ...items, 0x00];
        out.push(0x4e, body.length, ...body);
    }

    if (event.genres !== undefined && event.genres.length > 0) {
        const body = event.genres.flatMap(([lv1, lv2]) => [(lv1 << 4) | lv2, 0xff]);
        out.push(0x54, body.length, ...body);
    }

    if (event.video !== undefined) {
        const [streamContent, componentType] = event.video;
        out.push(0x50, 0x06, 0xf0 | streamContent, componentType, 0x00, 0x6a, 0x70, 0x6e);
    }

    for (const [index, audio] of (event.audios ?? []).entries()) {
        /*
         * stream_content / component_type / component_tag / stream_type /
         * simulcast_group_tag / フラグ / 言語 / **放送が付けた名前**。
         *
         * フラグは 多言語(1) 主音声(1) 品質(2) 標本化周波数(3) reserved(1)。
         * 名前は、種別も言語も同じ音声が2本あるとき**唯一の見分け**になる
         */
        const lang = [...(audio.lang ?? 'jpn')].map((c) => c.charCodeAt(0));
        const text = [...encodeAribText(audio.text ?? '')];
        const flags = ((audio.main ?? true) ? 0b0100_0000 : 0) | 0b0000_1110;
        const body = [0x02, audio.type, 0x10 + index, 0x0f, 0xff, flags, ...lang, ...text];
        out.push(0xc4, body.length, ...body);
    }

    return out;
}

/** EIT。番組表そのもの。table_id で p/f (0x4E) と schedule (0x50〜) が分かれる */
export function eitSection(options: EitOptions): Uint8Array {
    const body = [
        options.tableId,
        0x00,
        0x00,
        ...be(options.serviceId),
        0xc1 | ((options.version ?? 0) << 1),
        options.sectionNumber ?? 0,
        options.lastSectionNumber ?? 0,
        ...be(options.transportStreamId),
        ...be(options.originalNetworkId),
        options.segmentLastSectionNumber ?? options.lastSectionNumber ?? 0,
        options.lastTableId ?? options.tableId,
    ];

    for (const event of options.events) {
        const descriptors = eventDescriptors(event);
        body.push(
            ...be(event.eventId),
            ...mjdTime(event.startAt),
            ...bcdDuration(event.duration),
            ((event.runningStatus ?? 0) << 5) |
                (event.isFree === false ? 0x10 : 0x00) |
                ((descriptors.length >> 8) & 0x0f),
            descriptors.length & 0xff,
            ...descriptors,
        );
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

/**
 * ふつうの PMT。映像・音声のような ES を並べる。
 *
 * ロゴ用の `pmtSection` と違って中身を選べる。局を選り分ける
 * [service-filter.ts](service-filter.ts) を試すのに要る
 */
export function programMap(
    serviceId: number,
    pcrPid: number,
    /** `[種別, PID]`。**3つ目は記述子**の並び (字幕の部品タグなど) */
    streams: ([number, number] | [number, number, number[]])[],
    ecmPid?: number,
): Uint8Array {
    const programInfo =
        ecmPid === undefined ? [] : [0x09, 0x04, 0x00, 0x05, 0xe0 | (ecmPid >> 8), ecmPid & 0xff];
    const body = [
        0x02,
        0x00,
        0x00,
        ...be(serviceId),
        0xc1,
        0x00,
        0x00,
        0xe0 | (pcrPid >> 8),
        pcrPid & 0xff,
        ...be(0xf000 | programInfo.length),
        ...programInfo,
    ];
    for (const [streamType, pid, info = []] of streams) {
        body.push(streamType, 0xe0 | (pid >> 8), pid & 0xff, ...be(0xf000 | info.length), ...info);
    }
    return withCrc(body);
}

/** DSM-CC のセクションで包む */
function dsmccSection(tableId: number, message: number[]): Uint8Array {
    return withCrc([tableId, 0x00, 0x00, ...be(0), 0xc1, 0x00, 0x00, ...message]);
}

export interface DiiModuleSpec {
    moduleId: number;
    moduleSize: number;
    moduleVersion: number;
    name: string;
}

/**
 * DII。「このモジュールは何バイトで、名前は何か」を伝える。
 *
 * **複数のモジュールを載せられる。** 本物の BS はここに `LOGO-05` と
 * `CS_LOGO-05` を並べて流していて (実機の `BS15_0` で確認)、1つしか
 * 載せられない作りでは CS を取りこぼす道を試せない。
 */
export function diiSection(
    downloadId: number,
    blockSize: number,
    modules: DiiModuleSpec | DiiModuleSpec[],
): Uint8Array {
    const list = Array.isArray(modules) ? modules : [modules];
    const entries = list.flatMap((module) => {
        const name = [...new TextEncoder().encode(module.name)];
        const info = [0x02, name.length, ...name];
        return [
            ...be(module.moduleId),
            ...be(module.moduleSize >> 16),
            ...be(module.moduleSize & 0xffff),
            module.moduleVersion,
            info.length,
            ...info,
        ];
    });
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
        ...be(list.length), // numberOfModules
        ...entries,
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
