/**
 * 偽 Mirakurun。開発とE2Eで実チューナー無しに全体を動かすために使う。
 *
 * 番組は「現在時刻から SLOT_MS ごとの枠」を機械的に生成する。番組IDは枠番号から
 * 決めるので、同じ枠は何度取得しても同じIDになり、予約が別番組に化けない。
 * SLOT_MS を短くすると「数秒後に始まる番組」が作れるので、E2Eで録画完了まで通せる。
 */
import { type FakeService, SERVICES } from './services';

const PORT = Number(process.env.FAKE_MIRAKURUN_PORT ?? 40772);
const SLOT_MS = Number(process.env.FAKE_SLOT_MS ?? 10_000);
const SLOTS = Number(process.env.FAKE_SLOTS ?? 60);

const TITLES = [
    'テスト番組A',
    'テスト番組B 「初回放送」',
    'テストアニメ #12 決戦',
    'ニュース',
    'テスト番組C',
];

function programsFor(service: FakeService) {
    const base = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
    const programs = [];
    for (let i = 0; i < SLOTS; i++) {
        const startAt = base + i * SLOT_MS;
        const slot = startAt / SLOT_MS;
        programs.push({
            // 枠番号から決めるので取得のたびにIDが変わらない
            id: service.id * 100000 + (slot % 100000),
            eventId: slot % 65536,
            // 本物の Mirakurun と同じく ARIB のサービスID を返す。
            // ここに内部IDを返していたせいで、番組表が出ないバグを長らく見逃した
            serviceId: service.serviceId,
            networkId: service.networkId,
            startAt,
            duration: SLOT_MS,
            isFree: true,
            name: `${TITLES[(slot + service.serviceId) % TITLES.length]}`,
            description: `${service.name} のテスト番組 (slot ${slot})`,
            extended: {},
            genres: [{ lv1: 7, lv2: 0 }],
            audio: { componentType: 1 },
        });
    }
    return programs;
}

/** 録画の中身。本物のTSである必要はなく、止めるまで流れ続ければよい */
function fakeStream(signal: AbortSignal): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(188 * 20).fill(0x47);
    return new ReadableStream({
        start(controller) {
            const timer = setInterval(() => {
                try {
                    controller.enqueue(chunk);
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

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/api/version') return json({ current: '3.9.0-fake', latest: '3.9.0-fake' });
        if (url.pathname === '/api/services') {
            return json(
                SERVICES.map((s) => ({
                    id: s.id,
                    serviceId: s.serviceId,
                    networkId: s.networkId,
                    name: s.name,
                    type: 1,
                    channel: { type: s.type, channel: s.channel },
                })),
            );
        }
        if (url.pathname === '/api/programs') return json(SERVICES.flatMap(programsFor));
        if (url.pathname === '/api/tuners') {
            return json([
                { index: 0, name: 'adapter0', types: ['BS', 'CS'], isAvailable: true, isFault: false },
                { index: 1, name: 'adapter1', types: ['GR'], isAvailable: true, isFault: false },
                { index: 2, name: 'adapter2', types: ['BS', 'CS'], isAvailable: true, isFault: false },
                { index: 3, name: 'adapter3', types: ['GR'], isAvailable: true, isFault: false },
            ]);
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

        return new Response('not found', { status: 404 });
    },
});

console.log(`fake mirakurun listening on :${PORT} (slot ${SLOT_MS}ms)`);
