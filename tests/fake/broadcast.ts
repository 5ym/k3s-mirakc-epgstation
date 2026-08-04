/**
 * 偽の放送。**実チューナー無しで「電波」を作る。**
 *
 * ここが持つのは組み立てだけで、誰に配るかは知らない。使う先が2つあるため。
 *
 * - `tests/fake/tune.ts` … 選局コマンドの代わり。**本物のエージェント**に食わせる
 * - `tests/fake/agent.ts` … 偽エージェント。denpa の E2E で使う
 *
 * 番組も局名もJSONでは配らない。EIT と SDT を組み立てて電波に乗せる
 * (`src/lib/ts/synth.ts`)。こうしておかないと、denpa 側の解析が通っているか
 * どうかをテストで確かめられない。
 */
import {
    ddbSection,
    diiSection,
    eitSection,
    logoModule,
    nitSection,
    packetize,
    patSection,
    pmtSection,
    programMap,
    type SynthEvent,
    sdtSection,
    withCrc,
} from '../../src/lib/ts/synth';
import { type FakeService, SERVICES } from './services';

/**
 * 放送に乗るのと同じ形のロゴ (実機の地上波から拾った 48x24)。
 *
 * 8bit のパレット PNG だが、**色の表 (PLTE/tRNS) が入っていない。** ARIB では
 * 色が決め打ちなので送らない決まりで、受け取った側が入れて初めて絵になる。
 * ここを普通の PNG にしてしまうと、その入れ直しが抜けていても気づけない
 */
export const LOGO_PNG = Uint8Array.from(
    atob(
        'iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAMAAACLI47uAAAAo0lEQVR42r2SSwrDMAxE49UcSbOwwPc/VUcJLYXa8WRTIYwNevqMfLSHdvwfCGQgMlsm0YktkEAXAIAERuyBTCi3zqK4ByoxO1oOXQPcz1Ael58vT6XgbzM3AAfK6AJSBzX7lJgAofC4BPYAFTj71/bCArSHtrYp0HV2TWFXKGCl07IlkmkCn6HdCl+yekCVGOfiXKCxguuTu8D784Un6709Bl72jh+i3qzvNQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
);

/** 番組表を丸1日ぶん埋めるための追加分。局ごとの尺に応じて増やす */
const DAY = 30 * 60 * 60 * 1000;

const TITLES = [
    'テスト番組A',
    'テスト番組B 「初回放送」',
    'テストアニメ #12 決戦',
    'ニュース',
    'テスト番組C',
];

/**
 * テストから切り替えるつまみ。
 *
 * 偽エージェントは自分の中に持てばいいが、選局コマンドは**別プロセス**なので
 * ファイル越しに渡す (`FAKE_CONTROL`)。持ち方が違うだけで中身は同じ。
 */
export interface Knobs {
    /** カードが読めていない状態。掛かったままの TS を流す */
    scrambled: boolean;
    /** 放送の延長。EIT[p/f] の尺にこれを足す */
    extendedMs: number;
    /** EIT[p/f] を流さない。延長に追従できない局の見え方を確かめる */
    noPresentFollowing: boolean;
}

export const DEFAULT_KNOBS: Knobs = { scrambled: false, extendedMs: 0, noPresentFollowing: false };

/** 1枠の本数。E2E では短くして「数秒後に始まる番組」を作る */
const SLOTS = Number(process.env.FAKE_SLOTS ?? 60);

export function programsFor(service: FakeService): SynthEvent[] {
    const slotMs = service.slotMs;
    /*
     * 番組表(4時〜翌4時)が埋まるだけの本数を出す。短い尺の局は本数で稼ぐと多すぎるので上限を切る。
     *
     * 番組を出さない局もある (`noPrograms`)。**その局の番組表がまだ集まっていない状態**は
     * 本物でも普通に起きる。ロゴの中継まわりを見るためだけに置いてある局にまで
     * 番組を生やすと、他のテストが数えている本数がずれる
     */
    const count = service.noPrograms === true ? 0 : Math.max(SLOTS, Math.min(600, Math.ceil(DAY / slotMs)));
    // 作れる本数で覆える幅。尺が短い局は本数の上限で頭打ちになる
    const span = Math.min(DAY, count * slotMs);
    // 少し過去から始める。全部を過去にすると予約できる番組が1つも無くなる
    const base = Math.floor((Date.now() - span / 3) / slotMs) * slotMs;
    const programs: SynthEvent[] = [];
    for (let i = 0; i < count; i++) {
        const startAt = base + i * slotMs;
        const slot = startAt / slotMs;
        programs.push({
            // 枠番号から決めるので取得のたびにIDが変わらない
            eventId: slot % 65536,
            startAt,
            duration: slotMs,
            isFree: true,
            name: `${TITLES[(slot + service.serviceId) % TITLES.length]}`,
            description: `${service.name} のテスト番組 (slot ${slot})`,
            // 詳細は見出し付き。番組名にも概要にも出てこない語を入れておく
            // (ルールの「当てる範囲」を切り替えたときの違いを見るため)
            extended: { 出演者: 'ゲスト太郎 山田花子', 番組内容: `${service.name} の詳細` },
            genres: [[7, 0]],
            audioType: 3,
            video: [0x01, 0xb1],
        });
    }
    return programs;
}

/** その物理チャンネルに乗っている局 */
export function on(type: string, channel: string): FakeService[] {
    return SERVICES.filter((s) => s.type === type && s.channel === channel);
}

const serviceOf = (service: FakeService) => ({
    serviceId: service.serviceId,
    serviceType: service.serviceType,
    name: service.name,
});

const channelOf = (service: FakeService) => ({
    type: service.type,
    channel: service.channel,
    networkId: service.networkId,
    transportStreamId: service.networkId,
    remoteControlKeyId: service.type === 'GR' ? 9 : null,
    services: [serviceOf(service)],
});

/** 物理チャンネルの一覧。本物はスキャンの結果 (channels.json) */
export function channels() {
    const map = new Map<string, ReturnType<typeof channelOf>>();
    for (const service of SERVICES) {
        const key = `${service.type}:${service.channel}`;
        const found = map.get(key);
        if (found === undefined) map.set(key, channelOf(service));
        else found.services.push(serviceOf(service));
    }
    return [...map.values()];
}

/**
 * 番組表をセクションに割る。
 *
 * 1セクションは 4093 バイトまでなので、番組を詰められるだけ詰めて切る。
 * **セグメント (8セクション) の切れ目まで面倒を見る** — denpa は
 * `segment_last_section_number` を見て「もう来ない番号」を判断するので、
 * ここが嘘だと永久に揃わない。
 */
function scheduleSections(service: FakeService, events: SynthEvent[]): Uint8Array[] {
    const groups: SynthEvent[][] = [];
    for (let at = 0; at < events.length; at += 10) groups.push(events.slice(at, at + 10));
    if (groups.length === 0) groups.push([]);

    const last = groups.length - 1;
    return groups.map((chunk, index) =>
        eitSection({
            tableId: 0x50,
            serviceId: service.serviceId,
            transportStreamId: service.networkId,
            originalNetworkId: service.networkId,
            sectionNumber: index,
            lastSectionNumber: last,
            // このセグメントで実際に使っている最後の番号
            segmentLastSectionNumber: Math.min((index & ~7) + 7, last),
            lastTableId: 0x50,
            events: chunk,
        }),
    );
}

/** いま流れている番組。EIT[p/f] に載せる */
function present(events: SynthEvent[]): SynthEvent | undefined {
    const at = Date.now();
    return events.find((event) => event.startAt <= at && at < event.startAt + event.duration);
}

/**
 * 中身のパケットを並べる。
 *
 * 本物である必要はないが、ヘッダだけは本物らしくしておく。
 * 全部を 0x47 で埋めると 4バイト目の上位2ビットが立ち、denpa の
 * スクランブル判定が「掛かっている」と誤って読む。
 */
export function payload(pid: number, count: number, scrambled: boolean): Uint8Array {
    const buffer = new Uint8Array(188 * count);
    for (let i = 0; i < count; i++) {
        const at = i * 188;
        buffer[at] = 0x47;
        buffer[at + 1] = (pid >> 8) & 0x1f;
        buffer[at + 2] = pid & 0xff;
        // 上位2ビットが transport_scrambling_control、下位が adaptation/continuity
        buffer[at + 3] = scrambled ? 0x90 : 0x10;
        buffer.fill(0xff, at + 4, at + 188);
    }
    return buffer;
}

/** 局ごとの PID。実機と同じで、局ごとに別の値が振られている */
export const pidsOf = (index: number) => ({
    pmt: 0x1000 + index * 0x10,
    video: 0x1001 + index * 0x10,
    audio: 0x1002 + index * 0x10,
});

/**
 * ロゴのカルーセル (衛星)。**地上波とは伝送方式が違う。**
 *
 * CDT には載らず、データカルーセル (DSM-CC) で流れてくる。PAT →
 * エンジニアリングサービス (929) の PMT → component_tag 0x79 の ES →
 * DII → DDB と辿らないと拾えないので、そこまで作る。本物と同じ道筋にして
 * おかないと、テストだけ通って現物では永久に集まらない。
 *
 * **PAT と PMT は `tables()` のほうに載せる。** 中継に居るかどうかは PAT を
 * 見た時点で決まる (denpa は外れの中継をそこで見切る) ので、あとから別の PAT を
 * 流すと「居ないと分かったのにあとから出てくる」ことになる
 */
const ENGINEERING = { service: 929, pmt: 0x1f0, es: 0x1f1 };

function carouselPackets(services: FakeService[]): Uint8Array {
    const module = logoModule(0x05, [
        {
            logoId: services[0].serviceId % 512,
            services: services.map((s) => [s.networkId, s.serviceId] as [number, number]),
            data: LOGO_PNG,
        },
    ]);
    return Uint8Array.from([
        ...packetize(
            ENGINEERING.es,
            diiSection(0x1234, 4066, {
                moduleId: 1,
                moduleSize: module.length,
                moduleVersion: 1,
                name: 'LOGO-05',
            }),
        ),
        ...packetize(ENGINEERING.es, ddbSection(0x1234, 1, 1, 0, module)),
    ]);
}

/** 局ロゴ (地上波)。CDT に実体、SDT にどの局のものかが分かれて流れてくる */
function logoPackets(service: FakeService): Uint8Array {
    const be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
    const logoId = service.serviceId % 512;

    const cdt = withCrc([
        0xc8,
        0x00,
        0x00,
        ...be(service.networkId),
        0xc1,
        0x00,
        0x00,
        ...be(service.networkId),
        0x01,
        ...be(0xf000),
        0x05,
        ...be(logoId),
        ...be(1),
        ...be(LOGO_PNG.length),
        ...LOGO_PNG,
    ]);
    const sdt = withCrc([
        0x42,
        0x00,
        0x00,
        ...be(1),
        0xc1,
        0x00,
        0x00,
        ...be(service.networkId),
        0xff,
        ...be(service.serviceId),
        0xfc,
        ...be(0x8000 | 9),
        0xcf,
        0x07,
        0x01,
        ...be(logoId),
        ...be(1),
        ...be(service.networkId),
    ]);
    return Uint8Array.from([...packetize(0x0029, cdt), ...packetize(0x0011, sdt, 5)]);
}

/**
 * 物理チャンネル1本ぶんの表 (PAT / PMT / SDT / NIT)。選局したら真っ先に流れてくる。
 *
 * **NIT も出す。** チャンネルスキャンは NIT と SDT が**両方**揃って初めて
 * 「受信できた」とみなす (`ts/psi.ts` の `ServiceReader`)。偽エージェントは
 * スキャンの結果を作り物で返していたので要らなかったが、本物のエージェントに
 * 食わせるならこれが無いとどのチャンネルも見つからない。
 */
export function tables(services: FakeService[]): Uint8Array {
    /*
     * ロゴを積んでいる中継にはエンジニアリングサービス (929) が居る。
     * **PAT に載せるかどうかがそのまま「当たり外れ」になる** — denpa は
     * ここを見て、外れの中継を1秒ほどで見切る
     */
    const carousel = services.some((service) => service.carousel === true);
    const programs: [number, number][] = services.map((s, i) => [s.serviceId, pidsOf(i).pmt]);
    if (carousel) programs.push([ENGINEERING.service, ENGINEERING.pmt]);

    const parts: number[] = [...packetize(0x0000, patSection(programs))];
    if (carousel) {
        parts.push(...packetize(ENGINEERING.pmt, pmtSection(ENGINEERING.service, ENGINEERING.es, 0x79)));
    }
    for (const [index, service] of services.entries()) {
        const pids = pidsOf(index);
        parts.push(
            ...packetize(
                pids.pmt,
                programMap(service.serviceId, pids.video, [
                    [0x02, pids.video],
                    [0x0f, pids.audio],
                ]),
            ),
        );
    }

    const first = services[0];
    parts.push(
        ...packetize(
            0x0011,
            sdtSection(
                first.networkId,
                first.networkId,
                services.map((s) => [s.serviceId, s.serviceType, s.name] as [number, number, string]),
            ),
        ),
    );
    parts.push(
        ...packetize(
            0x0010,
            nitSection(first.networkId, first.type === 'GR' ? 9 : null, [
                [first.networkId, first.networkId, services.map((s) => [s.serviceId, s.serviceType])],
            ]),
        ),
    );
    return Uint8Array.from(parts);
}

/** 番組表 (EIT[schedule])。開いたら1回で全部流す */
export function schedule(services: FakeService[]): Uint8Array {
    const parts: number[] = [];
    for (const service of services) {
        const events = programsFor(service);
        for (const section of scheduleSections(service, events)) {
            parts.push(...packetize(0x0012, section));
        }
    }
    return Uint8Array.from(parts);
}

/** EIT[p/f]。いま流れている番組。延長はここに乗る */
export function nowOnAir(services: FakeService[], knobs: Knobs): Uint8Array {
    if (knobs.noPresentFollowing) return new Uint8Array(0);
    const parts: number[] = [];
    for (const service of services) {
        const current = present(programsFor(service));
        if (current === undefined) continue;
        parts.push(
            ...packetize(
                0x0012,
                eitSection({
                    tableId: 0x4e,
                    serviceId: service.serviceId,
                    transportStreamId: service.networkId,
                    originalNetworkId: service.networkId,
                    events: [{ ...current, duration: current.duration + knobs.extendedMs, runningStatus: 4 }],
                }),
            ),
        );
    }
    return Uint8Array.from(parts);
}

/** 送り出す間隔。本物の放送は途切れないので、細かく刻んで流し続ける */
const TICK = 100;

/**
 * 選局した状態を作る。**物理チャンネル丸ごと**しか無い。
 *
 * 局を選り分けるのも番組表を読むのも denpa の仕事なので、1本の TS に
 * その中継の局を全部乗せる。`knobs` は都度読む — 別プロセスから
 * ファイル越しに変えられることがあるため。
 */
export function broadcast(
    services: FakeService[],
    knobs: () => Knobs,
    send: (data: Uint8Array) => void,
): () => void {
    const carousel = services.filter((service) => service.type !== 'GR' && service.carousel === true);
    const logo = Uint8Array.from([
        ...services.filter((service) => service.type === 'GR').flatMap((s) => [...logoPackets(s)]),
        ...(carousel.length > 0 ? [...carouselPackets(carousel)] : []),
    ]);

    // 選局した直後に表と番組表を流す。本物も数百 ms で PAT が来る
    send(tables(services));
    send(schedule(services));
    send(nowOnAir(services, knobs()));

    let ticks = 0;
    const timer = setInterval(() => {
        ticks++;
        const now = knobs();
        // 実際の放送波と同じで、ロゴは時々しか流れてこない
        if (ticks % 5 === 0) send(logo);
        // 表と p/f は繰り返し流れてくる。途中から読んでも辻褄が合うように
        if (ticks % 10 === 0) {
            send(tables(services));
            send(nowOnAir(services, now));
        }
        // 映像と音声の代わり。局ごとに別のPIDで流す (選り分けを試すため)
        for (let index = 0; index < services.length; index++) {
            send(payload(pidsOf(index).video, 10, now.scrambled));
        }
    }, TICK);

    return () => clearInterval(timer);
}
