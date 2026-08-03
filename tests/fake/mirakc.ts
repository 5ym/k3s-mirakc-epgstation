/**
 * 偽 mirakc。開発とE2Eで実チューナー無しに全体を動かすために使う。
 *
 * 番組は「現在時刻から SLOT_MS ごとの枠」を機械的に生成する。番組IDは枠番号から
 * 決めるので、同じ枠は何度取得しても同じIDになり、予約が別番組に化けない。
 * SLOT_MS を短くすると「数秒後に始まる番組」が作れるので、E2Eで録画完了まで通せる。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packetize, withCrc } from '../../src/lib/ts/synth';
import { type FakeService, SERVICES } from './services';

/** ロゴとして流す PNG。中身は問われないので小さいものでよい */
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

const PORT = Number(process.env.FAKE_MIRAKC_PORT ?? 40772);
/** denpa の置き場。本物では同じものを mirakc 側にも見せてある */
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

function programsFor(service: FakeService) {
    const slotMs = service.slotMs;
    // 番組表(4時〜翌4時)が埋まるだけの本数を出す。短い尺の局は本数で稼ぐと多すぎるので上限を切る
    const count = Math.max(SLOTS, Math.min(600, Math.ceil(DAY / slotMs)));
    // 作れる本数で覆える幅。尺が短い局は本数の上限で頭打ちになる
    const span = Math.min(DAY, count * slotMs);
    // 少し過去から始める。全部を過去にすると予約できる番組が1つも無くなる
    const base = Math.floor((Date.now() - span / 3) / slotMs) * slotMs;
    const programs = [];
    for (let i = 0; i < count; i++) {
        const startAt = base + i * slotMs;
        const slot = startAt / slotMs;
        programs.push({
            // 枠番号から決めるので取得のたびにIDが変わらない
            id: service.id * 100000 + (slot % 100000),
            eventId: slot % 65536,
            // 本物の mirakc と同じく ARIB のサービスID を返す。
            // ここに内部IDを返していたせいで、番組表が出ないバグを長らく見逃した
            serviceId: service.serviceId,
            networkId: service.networkId,
            startAt,
            duration: slotMs,
            isFree: true,
            name: `${TITLES[(slot + service.serviceId) % TITLES.length]}`,
            description: `${service.name} のテスト番組 (slot ${slot})`,
            // 詳細は見出し付き。番組名にも概要にも出てこない語を入れておく
            // (ルールの「当てる範囲」を切り替えたときの違いを見るため)
            extended: { 出演者: 'ゲスト太郎 山田花子', 番組内容: `${service.name} の詳細` },
            genres: [{ lv1: 7, lv2: 0 }],
            audio: { componentType: 1 },
            // 本物と同じ形で返す。番組詳細はこれを読んで「ステレオ (日本語)」等に直す
            audios: [{ componentType: 3, isMain: true, samplingRate: 48000, langs: ['jpn'] }],
            video: { type: 'mpeg2', resolution: '1080i', streamContent: 1, componentType: 179 },
        });
    }
    return programs;
}

/** 録画の中身。本物のTSである必要はなく、止めるまで流れ続ければよい */
/**
 * 188バイトのパケットを並べる。
 *
 * 中身は本物である必要はないが、ヘッダだけは本物らしくしておく。
 * 全部を 0x47 で埋めると 4バイト目の上位2ビットが立ち、denpa の
 * スクランブル判定が「掛かっている」と誤って読む。
 *
 * FAKE_SCRAMBLED=1 のときは逆に、わざと掛かっている状態にする
 * (エンコード前の自動解除を通しで見るため)。
 */
function packets(count: number, scrambled: boolean): Uint8Array {
    const buffer = new Uint8Array(188 * count);
    for (let i = 0; i < count; i++) {
        const at = i * 188;
        buffer[at] = 0x47;
        buffer[at + 1] = 0x01;
        buffer[at + 2] = 0x00;
        // 上位2ビットが transport_scrambling_control、下位が adaptation/continuity
        buffer[at + 3] = scrambled ? 0x90 : 0x10;
        buffer.fill(0xff, at + 4, at + 188);
    }
    return buffer;
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
 * チューナー。既定は全部空きにしておく。塞がっていると予約が競合して、
 * チューナーの見え方と関係ないテストまで落ちる
 */
const TUNERS = [
    {
        index: 0,
        name: 'adapter0',
        types: ['BS', 'CS'],
        isAvailable: true,
        isFault: false,
        // 本物と同じ形にしておく。ロゴ収集は空きがあるときだけ自分で開く
        isFree: true,
        isUsing: false,
        users: [],
    },
    {
        index: 1,
        name: 'adapter1',
        types: ['GR'],
        isAvailable: true,
        isFault: false,
        // 本物と同じ形にしておく。ロゴ収集は空きがあるときだけ自分で開く
        isFree: true,
        isUsing: false,
        users: [],
    },
    {
        index: 2,
        name: 'adapter2',
        types: ['BS', 'CS'],
        isAvailable: true,
        isFault: false,
        // 本物と同じ形にしておく。ロゴ収集は空きがあるときだけ自分で開く
        isFree: true,
        isUsing: false,
        users: [],
    },
    {
        index: 3,
        name: 'adapter3',
        types: ['GR'],
        isAvailable: true,
        isFault: false,
        // 本物と同じ形にしておく。ロゴ収集は空きがあるときだけ自分で開く
        isFree: true,
        isUsing: false,
        users: [],
    },
];

/** テストから切り替える。使用中と故障の見え方を確かめるため */
let busyTuners = false;

/**
 * 放送の延長。/api/programs/:id の尺にこれを足して返す。
 * 本物では EIT[p/f] を拾った mirakc が書き換えるところ
 */
let extendedMs = 0;
/** 番組単位で開いても何も流れてこない状況。denpa の切り替えを確かめるため */
let programStreamSilent = false;
/** 一時的な追従役を立てた番組。本物は User-Agent を見て決める */
const trackedPrograms = new Set<number>();

/** スキャンの状態。本物はチューナー側のエージェントが持っている */
/** mirakc を入れ直した回数。テストから数えられるようにしておく */
let restarts = 0;

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
    mirakc: true,
};

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
    }
    scanState = {
        ...scanState,
        state: 'done',
        phase: '完了',
        finishedAt: Date.now(),
        mirakc: true,
        log: [...scanState.log, 'mirakc を起動しています...'],
    };
}

/** テストから切り替える。カードが読めていない状態を作るため */
let scrambled = process.env.FAKE_SCRAMBLED === '1';

/**
 * 局ロゴを放送波に混ぜる。本物と同じく CDT (実体) と SDT (どの局のものか) に
 * 分かれて流れてくるので、denpa 側は両方を読んで初めて紐付けられる
 */
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
 * TSを流す。
 *
 * `services` を渡すのは**物理チャンネルを丸ごと開いたときだけ**。
 * 本物の mirakc はサービス単位・番組単位のストリームではその局に要るPIDだけを
 * 通すので、ロゴを載せている CDT (PID 0x0029) はどの局のPMTにも載っていない都合で
 * まるごと落ちる。実機で BS をサービス単位で3分読んでも1つも来なかった。
 * ここでも同じようにしておかないと、テストだけ通って現物では永久に集まらない。
 */
function fakeStream(signal: AbortSignal, services: FakeService[] = []): ReadableStream<Uint8Array> {
    const logo = Uint8Array.from(services.flatMap((service) => [...logoPackets(service)]));
    const chunk = packets(20, scrambled);
    return new ReadableStream({
        start(controller) {
            // 実際の放送波と同じで、ロゴは時々しか流れてこない
            let ticks = 0;
            const timer = setInterval(() => {
                try {
                    controller.enqueue(++ticks % 5 === 0 ? logo : chunk);
                } catch {
                    clearInterval(timer);
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

const serviceOf = (service: FakeService) => ({
    id: service.id,
    serviceId: service.serviceId,
    name: service.name,
});

const channelOf = (service: FakeService) => ({
    type: service.type,
    channel: service.channel,
    name: service.channel,
    services: [serviceOf(service)],
});

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/*
 * 起きたことを教える口 (SSE)。本物では `/events`。**`/api` の下ではない。**
 *
 * denpa はこれを聞いて番組表を取り直し、放送の延長にも追い付く。
 * 定期実行の保険も残っているが、そちらは分単位なので、
 * ここが動いていることはテストからしか確かめられない。
 */
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();

function push(name: string, data: unknown): void {
    const chunk = new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const listener of listeners) {
        try {
            listener.enqueue(chunk);
        } catch {
            // 既に閉じている購読者。次の cancel で片付く
        }
    }
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

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    fetch(request) {
        const url = new URL(request.url);

        // テスト用。チューナーが塞がっている状態に切り替える
        if (url.pathname === '/__control/tuners' && request.method === 'POST') {
            busyTuners = url.searchParams.get('busy') === '1';
            return json({ busy: busyTuners });
        }
        // テスト用。カードが読めていない状態(スクランブルされたまま)に切り替える
        /*
         * 放送の延長。ここを動かすと /api/programs/:id の終了時刻が後ろへ動く。
         * 本物では EIT[p/f] で書き換わるところ
         */
        if (url.pathname === '/__control/extend' && request.method === 'POST') {
            extendedMs = Number(url.searchParams.get('ms') ?? 0);
            // 本物は EIT[p/f] が変わった時点でこれを流す。denpa はこれで気付く
            for (const service of SERVICES) push('onair.program-changed', { serviceId: service.id });
            return json({ ok: true, extendedMs });
        }
        // テスト用。番組表が更新されたことにする
        if (url.pathname === '/__control/epg-updated' && request.method === 'POST') {
            for (const service of SERVICES) push('epg.programs-updated', { serviceId: service.id });
            return json({ ok: true, listeners: listeners.size });
        }
        if (url.pathname === '/__control/listeners') {
            return json({ listeners: listeners.size });
        }
        if (url.pathname === '/__control/onair' && request.method === 'POST') {
            programStreamSilent = url.searchParams.get('silent') === '1';
            return json({ ok: true, programStreamSilent });
        }
        if (url.pathname === '/__control/onair') {
            return json({ tracked: [...trackedPrograms] });
        }
        if (url.pathname === '/__control/scrambled' && request.method === 'POST') {
            scrambled = new URL(request.url).searchParams.get('on') === '1';
            return json({ scrambled });
        }

        /*
         * スクランブル解除の受け口。本物では mirakc と同じコンテナに居る別プロセス
         * (mirakc/descrambler.mjs) で、B-CASカードを持っているのはそちら側。
         * ここでは同じ口を偽 mirakc が兼ねる。
         */
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
        /*
         * チャンネルスキャン。本物はチューナー側のエージェント (mirakc/agent.py) が
         * 物理チャンネルを総当たりする。ここでは同じ形の状態を返すだけ
         */
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
                    mirakc: false,
                };
                void advanceScan();
                return json({ started: true, message: 'チャンネルスキャンを始めました' });
            });
        }
        if (url.pathname === '/denpa/scan') return json(scanState);

        /*
         * mirakc の入れ直し。本物は agent が mirakc を止めて起こし直す。
         * 起きた mirakc は自分で局と番組表を取りに行くので、denpa 側は
         * 受け付けられたことだけ分かればいい
         */
        if (url.pathname === '/denpa/mirakc/restart' && request.method === 'POST') {
            if (scanState.state === 'running') {
                return json({ ok: false, message: 'チャンネルスキャン中は入れ直せません' }, 409);
            }
            restarts++;
            return json({ ok: true, message: 'mirakc を入れ直しました' });
        }
        if (url.pathname === '/__control/restarts') return json({ restarts });

        if (url.pathname === '/events') return eventStream();

        if (url.pathname === '/api/version') return json({ current: '3.9.0-fake', latest: '3.9.0-fake' });
        if (url.pathname === '/api/services') {
            return json(
                SERVICES.map((s) => ({
                    id: s.id,
                    serviceId: s.serviceId,
                    networkId: s.networkId,
                    name: s.name,
                    type: s.serviceType,
                    channel: { type: s.type, channel: s.channel },
                    hasLogoData: true,
                })),
            );
        }
        if (url.pathname === '/api/programs') return json(SERVICES.flatMap(programsFor));

        // 番組1つぶん。放送が延びた分 (extendedMs) をここに乗せる
        const program = url.pathname.match(/^\/api\/programs\/(\d+)$/);
        if (program !== null) {
            const found = SERVICES.flatMap(programsFor).find((p) => p.id === Number(program[1]));
            if (found === undefined) return new Response('unknown program', { status: 404 });
            return json({ ...found, duration: found.duration + extendedMs });
        }
        if (url.pathname === '/api/channels') {
            // 物理チャンネル単位。同じ ch に複数の局が相乗りしている
            const channels = new Map<string, ReturnType<typeof channelOf>>();
            for (const service of SERVICES) {
                const key = `${service.type}:${service.channel}`;
                const found = channels.get(key) ?? channelOf(service);
                if (channels.has(key)) {
                    found.services.push(serviceOf(service));
                }
                channels.set(key, found);
            }
            return json([...channels.values()]);
        }
        if (url.pathname === '/api/tuners') {
            return json(
                TUNERS.map((tuner) => {
                    if (!busyTuners) return tuner;
                    if (tuner.index === 1) {
                        return {
                            ...tuner,
                            isFree: false,
                            isUsing: true,
                            /*
                             * 本物と同じく User-Agent がそのまま出る。denpa は
                             * 用途と録画IDだけを ASCII で載せ (ヘッダなので)、
                             * 読める言葉に直すのは画面側でやる
                             */
                            users: [{ id: 'denpa', priority: 2, agent: 'denpa (rec 1)' }],
                        };
                    }
                    if (tuner.index === 2) {
                        /*
                         * mirakc 自身の仕事。**User-Agent が付かない。**
                         * 「不明」と出していた頃は、いちばんよく居座っている相手が
                         * 誰なのか画面から分からなかった
                         */
                        return {
                            ...tuner,
                            isFree: false,
                            isUsing: true,
                            users: [{ id: 'job:epg.update-schedules', priority: -1 }],
                        };
                    }
                    if (tuner.index === 3) return { ...tuner, isAvailable: false, isFault: true };
                    return tuner;
                }),
            );
        }

        /*
         * 番組単位のストリーム。本物は番組が始まるまで1バイトも出さず、
         * 番組が終わると自分で閉じる。ここでは「開いたら流れ、閉じるのは
         * denpa 側から」で足りる (延長の追従は /api/programs/:id のほうで見る)。
         *
         * 本物と同じく、User-Agent が EPGStation/ で始まるかどうかで
         * 一時的な追従役を立てるかが決まる。立てたことを控えて、テストから見えるようにする
         */
        const programStream = url.pathname.match(/^\/api\/programs\/(\d+)\/stream$/);
        if (programStream !== null) {
            const found = SERVICES.flatMap(programsFor).find((p) => p.id === Number(programStream[1]));
            if (found === undefined) return new Response('unknown program', { status: 404 });
            if ((request.headers.get('user-agent') ?? '').startsWith('EPGStation/')) {
                trackedPrograms.add(found.id);
            }
            if (programStreamSilent) {
                /*
                 * 番組が始まらない状況。denpa はサービス単位へ切り替えるはず。
                 *
                 * 何も enqueue しないと Bun は応答ヘッダごと送らずに待つ。本物は
                 * ヘッダだけ先に返して黙るので、長さ0のチャンクで押し出しておく
                 * (0バイトなので denpa 側の「1バイトも来ない」判定は変わらない)
                 */
                return new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new Uint8Array(0));
                        },
                    }),
                    { headers: { 'Content-Type': 'video/MP2T' } },
                );
            }
            // サービス単位・番組単位のストリームにロゴは載らない (fakeStream)
            return new Response(fakeStream(request.signal), {
                headers: { 'Content-Type': 'video/MP2T' },
            });
        }

        const stream = url.pathname.match(/^\/api\/services\/(\d+)\/stream$/);
        if (stream !== null) {
            if (!SERVICES.some((s) => s.id === Number(stream[1]))) {
                return new Response('unknown service', { status: 404 });
            }
            return new Response(fakeStream(request.signal), {
                headers: { 'Content-Type': 'video/MP2T' },
            });
        }

        /*
         * 物理チャンネルを丸ごと。**ロゴが載るのはこちらだけ。**
         * 1本のTSにその中継に乗っている局が全部流れているので、
         * そこに居る局のぶんをまとめて出す
         */
        const channelStream = url.pathname.match(/^\/api\/channels\/([^/]+)\/([^/]+)\/stream$/);
        if (channelStream !== null) {
            const type = decodeURIComponent(channelStream[1]);
            const channel = decodeURIComponent(channelStream[2]);
            const on = SERVICES.filter((s) => s.type === type && s.channel === channel);
            if (on.length === 0) return new Response('unknown channel', { status: 404 });
            return new Response(fakeStream(request.signal, on), {
                headers: { 'Content-Type': 'video/MP2T' },
            });
        }

        return new Response('not found', { status: 404 });
    },
});

console.log(`fake mirakc listening on :${PORT}`);
