/**
 * 偽チューナーエージェント。開発とE2Eで実チューナー無しに全体を動かすために使う。
 *
 * **本物と同じく、返すのは素のTSだけ。** 番組表も局名もJSONでは配らず、
 * EIT と SDT を組み立てて電波に乗せる (`src/lib/ts/synth.ts`)。こうしておかないと、
 * denpa 側の解析が通っているかどうかをテストで確かめられない。
 *
 * 番組は「現在時刻から SLOT_MS ごとの枠」を機械的に生成する。event_id は枠番号から
 * 決めるので、同じ枠は何度取得しても同じIDになり、予約が別番組に化けない。
 * SLOT_MS を短くすると「数秒後に始まる番組」が作れるので、E2Eで録画完了まで通せる。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    ddbSection,
    diiSection,
    eitSection,
    logoModule,
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
const LOGO_PNG = Uint8Array.from(
    atob(
        'iVBORw0KGgoAAAANSUhEUgAAADAAAAAYCAMAAACLI47uAAAAo0lEQVR42r2SSwrDMAxE49UcSbOwwPc/VUcJLYXa8WRTIYwNevqMfLSHdvwfCGQgMlsm0YktkEAXAIAERuyBTCi3zqK4ByoxO1oOXQPcz1Ael58vT6XgbzM3AAfK6AJSBzX7lJgAofC4BPYAFTj71/bCArSHtrYp0HV2TWFXKGCl07IlkmkCn6HdCl+yekCVGOfiXKCxguuTu8D784Un6709Bl72jh+i3qzvNQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
);

const PORT = Number(process.env.FAKE_AGENT_PORT ?? 40773);
/** denpa の置き場。本物では同じものをエージェント側にも見せてある */
const ROOTS: Record<string, string> = {
    recorded: resolve(process.env.RECORDED_DIR ?? '/recorded'),
    library: resolve(process.env.LIBRARY_DIR ?? '/library'),
};
const SLOTS = Number(process.env.FAKE_SLOTS ?? 60);
/** 番組表を丸1日ぶん埋めるための追加分。局ごとの尺に応じて増やす */
const DAY = 30 * 60 * 60 * 1000;

const TITLES = [
    'テスト番組A',
    'テスト番組B 「初回放送」',
    'テストアニメ #12 決戦',
    'ニュース',
    'テスト番組C',
];

function programsFor(service: FakeService): SynthEvent[] {
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
function on(type: string, channel: string): FakeService[] {
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
function channels() {
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
 * 偽のスクランブル解除。本物の復号はせず、4バイト目の
 * transport_scrambling_control を落とすだけ。
 *
 * 本物と同じく、渡されるのは生TSの置き場からの相対パス。
 */
function unscramble(root: string, input: string, output: string): { ok: boolean; error: string } {
    const base = ROOTS[root];
    if (base === undefined) return { ok: false, error: `知らない置き場です: ${root}` };
    const from = resolve(base, input);
    const to = resolve(base, output);
    if (!from.startsWith(`${base}/`) || !to.startsWith(`${base}/`)) {
        return { ok: false, error: `${root} の置き場の外は解除に回せません` };
    }
    if (!existsSync(from)) return { ok: false, error: `${from} が見えません` };

    const buffer = readFileSync(from);
    for (let i = 0; i + 188 <= buffer.length; i += 188) buffer[i + 3] &= 0x3f;
    writeFileSync(to, buffer);
    return { ok: true, error: '' };
}

/**
 * 中身のパケットを並べる。
 *
 * 本物である必要はないが、ヘッダだけは本物らしくしておく。
 * 全部を 0x47 で埋めると 4バイト目の上位2ビットが立ち、denpa の
 * スクランブル判定が「掛かっている」と誤って読む。
 *
 * FAKE_SCRAMBLED=1 のときは逆に、わざと掛かっている状態にする
 * (エンコード前の自動解除を通しで見るため)。
 */
function payload(pid: number, count: number): Uint8Array {
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
const pidsOf = (index: number) => ({
    pmt: 0x1000 + index * 0x10,
    video: 0x1001 + index * 0x10,
    audio: 0x1002 + index * 0x10,
});

/** テストから切り替える。カードが読めていない状態を作るため */
let scrambled = process.env.FAKE_SCRAMBLED === '1';
/** チューナーが塞がっている状態。取り合いの見え方を確かめる */
let busyTuners = false;
/** 放送の延長。EIT[p/f] の尺にこれを足す */
let extendedMs = 0;
/** EIT[p/f] を流さない状態。延長に追従できないときの見え方を確かめる */
let noPresentFollowing = false;

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

/** 物理チャンネル1本ぶんの表 (PAT / PMT / SDT)。選局したら真っ先に流れてくる */
function tables(services: FakeService[]): Uint8Array {
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
    parts.push(
        ...packetize(
            0x0011,
            sdtSection(
                services[0].networkId,
                services[0].networkId,
                services.map((s) => [s.serviceId, s.serviceType, s.name] as [number, number, string]),
            ),
        ),
    );
    return Uint8Array.from(parts);
}

/** 番組表 (EIT[schedule])。開いたら1回で全部流す */
function schedule(services: FakeService[]): Uint8Array {
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
function nowOnAir(services: FakeService[]): Uint8Array {
    if (noPresentFollowing) return new Uint8Array(0);
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
                    events: [{ ...current, duration: current.duration + extendedMs, runningStatus: 4 }],
                }),
            ),
        );
    }
    return Uint8Array.from(parts);
}

/**
 * 選局してTSを流す。
 *
 * 本物のエージェントと同じで、**物理チャンネル丸ごと**しか無い。局を選り分けるのも
 * 番組表を読むのも denpa の仕事なので、ここでは1本の TS にその中継の局を全部乗せる。
 */
function fakeStream(signal: AbortSignal, services: FakeService[]): ReadableStream<Uint8Array> {
    const carousel = services.filter((service) => service.type !== 'GR' && service.carousel === true);
    const logo = Uint8Array.from([
        ...services.filter((service) => service.type === 'GR').flatMap((s) => [...logoPackets(s)]),
        ...(carousel.length > 0 ? [...carouselPackets(carousel)] : []),
    ]);

    return new ReadableStream({
        start(controller) {
            const send = (data: Uint8Array) => {
                if (data.length === 0) return;
                try {
                    controller.enqueue(data);
                } catch {
                    // 既に閉じている
                }
            };
            // 選局した直後に表と番組表を流す。本物も数百 ms で PAT が来る
            send(tables(services));
            send(schedule(services));
            send(nowOnAir(services));

            let ticks = 0;
            const timer = setInterval(() => {
                ticks++;
                // 実際の放送波と同じで、ロゴは時々しか流れてこない
                if (ticks % 5 === 0) send(logo);
                // 表と p/f は繰り返し流れてくる。途中から読んでも辻褄が合うように
                if (ticks % 10 === 0) {
                    send(tables(services));
                    send(nowOnAir(services));
                }
                // 映像と音声の代わり。局ごとに別のPIDで流す (選り分けを試すため)
                for (let index = 0; index < services.length; index++) {
                    send(payload(pidsOf(index).video, 10));
                }
            }, 100);
            signal.addEventListener('abort', () => {
                clearInterval(timer);
                try {
                    controller.close();
                } catch {
                    // 既に閉じていれば何もしない
                }
            });
        },
    });
}

/** チューナー。既定は全部空きにしておく */
const TUNERS = [
    { index: 0, name: 'adapter0', types: ['BS', 'CS'], disabled: false },
    { index: 1, name: 'adapter1', types: ['GR'], disabled: false },
    { index: 2, name: 'adapter2', types: ['BS', 'CS'], disabled: false },
    { index: 3, name: 'adapter3', types: ['GR'], disabled: false },
];

interface Lease {
    type: string;
    channel: string;
    users: { use: string; priority: number }[];
}

/** いま開いている選局。本物のプールに当たるもの */
const leases = new Map<number, Lease>();

function tunerStatus() {
    return TUNERS.map((tuner) => {
        /*
         * 塞がっているのは**衛星のチューナー**にしてある。地上波を塞ぐと、
         * 同時に走っている局ロゴのテストが「地上波の空きが無い」で
         * 始められなくなる (偽エージェントは spec をまたいで共有)
         */
        if (busyTuners && tuner.index === 0) {
            return {
                ...tuner,
                channel: { type: 'BS', channel: 'BS11_0' },
                users: [
                    { use: 'rec 1', priority: 10 },
                    { use: 'epg BS11_0', priority: 3 },
                ],
                pid: 1234,
                error: null,
            };
        }
        const lease = leases.get(tuner.index);
        return {
            ...tuner,
            channel: lease === undefined ? null : { type: lease.type, channel: lease.channel },
            users: lease?.users ?? [],
            pid: lease === undefined ? null : 1234,
            error: null,
        };
    });
}

/** どのチューナーに載せるか。種別が合う空きを1つ取るだけ */
function assign(type: string): number | null {
    for (const tuner of TUNERS) {
        if (!tuner.types.includes(type)) continue;
        if (busyTuners && tuner.index === 0) continue;
        if (!leases.has(tuner.index)) return tuner.index;
    }
    return null;
}

/** スキャンの状態 */
let scanState = {
    state: 'idle',
    phase: '',
    log: [] as string[],
    scanned: 0,
    total: 0,
    channels: 0,
    error: null as string | null,
    startedAt: null as number | null,
    finishedAt: null as number | null,
};

/*
 * 起きたことを知らせる口 (SSE)。本物では `/denpa/events`。
 * denpa はこれを聞いてチューナー画面を更新し、スキャンの進み具合を出す
 */
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();

function emit(name: string, data: unknown = {}): void {
    const chunk = new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const listener of listeners) {
        try {
            listener.enqueue(chunk);
        } catch {
            // 既に閉じている購読者。次の cancel で片付く
        }
    }
}

/** 総当たりの進み方を真似る。1チャンネルずつ進んで、いくつか見つける */
async function advanceScan(): Promise<void> {
    for (let i = 0; i < scanState.total; i++) {
        await Bun.sleep(120);
        const found = i % 2 === 0;
        scanState = {
            ...scanState,
            scanned: i + 1,
            channels: scanState.channels + (found ? 1 : 0),
            log: [...scanState.log, `T${20 + i}: ${found ? '2 サービス' : '受信できませんでした'}`],
        };
        emit('scan');
    }
    scanState = {
        ...scanState,
        state: 'done',
        phase: '完了',
        finishedAt: Date.now(),
        log: [...scanState.log, '完了しました'],
    };
    emit('scan');
    emit('channels');
}

function eventStream(): Response {
    let self: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            self = controller;
            listeners.add(controller);
        },
        cancel() {
            listeners.delete(self);
        },
    });
    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function openStream(url: URL, signal: AbortSignal): Response {
    const type = url.searchParams.get('type') ?? '';
    const channel = url.searchParams.get('channel') ?? '';
    const use = url.searchParams.get('use') ?? '不明';
    const priority = Number(url.searchParams.get('priority') ?? 0);
    const services = on(type, channel);
    if (services.length === 0) return json({ error: 'unknown channel' }, 404);

    // 同じチャンネルが開いていれば相乗り。無ければ空きチューナーを取る
    let index = [...leases.entries()].find(
        ([, lease]) => lease.type === type && lease.channel === channel,
    )?.[0];
    if (index === undefined) {
        const picked = assign(type);
        if (picked === null) return json({ error: `${type} のチューナーに空きがありません` }, 409);
        index = picked;
        leases.set(index, { type, channel, users: [] });
    }
    const lease = leases.get(index) as Lease;
    const user = { use, priority };
    lease.users.push(user);
    emit('tuners');

    const at = index;
    signal.addEventListener('abort', () => {
        lease.users = lease.users.filter((u) => u !== user);
        if (lease.users.length === 0) leases.delete(at);
        emit('tuners');
    });

    return new Response(fakeStream(signal, services), {
        headers: { 'Content-Type': 'video/MP2T' },
    });
}

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    idleTimeout: 0,
    fetch(request) {
        const url = new URL(request.url);

        // --- テスト用の口 -------------------------------------------------
        if (url.pathname === '/__control/tuners' && request.method === 'POST') {
            busyTuners = url.searchParams.get('busy') === '1';
            emit('tuners');
            return json({ busy: busyTuners });
        }
        /*
         * 放送の延長。ここを動かすと EIT[p/f] の終了時刻が後ろへ動く。
         * 本物では野球が延びたときに放送局が書き換えるところ
         */
        if (url.pathname === '/__control/extend' && request.method === 'POST') {
            extendedMs = Number(url.searchParams.get('ms') ?? 0);
            return json({ ok: true, extendedMs });
        }
        /* EIT[p/f] を止める。延長に追従できない局の見え方を確かめる */
        if (url.pathname === '/__control/onair' && request.method === 'POST') {
            noPresentFollowing = url.searchParams.get('silent') === '1';
            return json({ ok: true, noPresentFollowing });
        }
        if (url.pathname === '/__control/listeners') return json({ listeners: listeners.size });
        if (url.pathname === '/__control/scrambled' && request.method === 'POST') {
            scrambled = url.searchParams.get('on') === '1';
            return json({ scrambled });
        }

        // --- 本物と同じ口 -------------------------------------------------
        if (url.pathname === '/denpa/stream') return openStream(url, request.signal);
        if (url.pathname === '/denpa/events') return eventStream();
        if (url.pathname === '/denpa/tuners') return json({ tuners: tunerStatus() });
        if (url.pathname === '/denpa/channels') return json(channels());

        if (url.pathname === '/denpa/card') {
            return json(
                scrambled
                    ? {
                          ok: false,
                          pcscd: true,
                          readers: [],
                          message: 'pcscd は動いていますが、カードリーダーが見つかりません',
                      }
                    : {
                          ok: true,
                          pcscd: true,
                          readers: ['Fake Card Reader 00 00'],
                          message: 'カードリーダーが見えています (1 台)',
                      },
            );
        }
        if (url.pathname === '/denpa/decode' && request.method === 'POST') {
            return request
                .json()
                .then((body: { root?: string; input: string; output: string }) =>
                    json(unscramble(body.root ?? 'recorded', body.input, body.output)),
                );
        }
        if (url.pathname === '/denpa/scan' && request.method === 'POST') {
            return request.json().then((body: { types?: string[] }) => {
                const types = body.types ?? ['GR'];
                scanState = {
                    state: 'running',
                    phase: 'スキャン中',
                    log: [`${types.join(', ')} を探しています...`],
                    scanned: 0,
                    total: types.length * 4,
                    channels: 0,
                    error: null,
                    startedAt: Date.now(),
                    finishedAt: null,
                };
                void advanceScan();
                return json({ started: true, message: 'チャンネルスキャンを始めました' });
            });
        }
        if (url.pathname === '/denpa/scan') return json(scanState);
        if (url.pathname === '/denpa/scan/stop' && request.method === 'POST') {
            if (scanState.state !== 'running') {
                return json({ stopped: false, message: '実行中ではありません' }, 409);
            }
            scanState = { ...scanState, state: 'canceled', phase: '中断', finishedAt: Date.now() };
            emit('scan');
            return json({ stopped: true, message: 'チャンネルスキャンを中断しています' });
        }

        return new Response('not found', { status: 404 });
    },
});

console.log(`fake tuner agent listening on :${PORT}`);
