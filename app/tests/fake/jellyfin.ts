/**
 * 偽 Jellyfin。
 *
 * 録画の削除は Jellyfin の UI からファイルを直接消す運用なので、denpa が Jellyfin に
 * 対してすることは「新しい録画を置いたのでスキャンして」と伝えるだけ。
 * そのぶんこの偽物も /Library/Refresh を受けて数えるだけでよい。
 */
const PORT = Number(process.env.FAKE_JELLYFIN_PORT ?? 8096);

let refreshCount = 0;
let guideRefreshCount = 0;
// 実 Jellyfin の /System/Configuration/livetv 相当
const tunerHosts: Record<string, unknown>[] = [];
const listingProviders: Record<string, unknown>[] = [];
let nextId = 1;
// Jellyfin のライブTV画面で録画ボタンを押すと作られるタイマー
const timers: Record<string, unknown>[] = [];

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/__control/state') {
            return json({ refreshCount, guideRefreshCount, tunerHosts, listingProviders, timers });
        }
        // 「録画ボタンを押した」を再現する
        if (url.pathname === '/__control/timer' && request.method === 'POST') {
            const body = (await request.json()) as Record<string, unknown>;
            const timer = { Id: `timer-${nextId++}`, PrePaddingSeconds: 0, PostPaddingSeconds: 0, ...body };
            timers.push(timer);
            return json(timer);
        }
        if (url.pathname === '/__control/reset' && request.method === 'POST') {
            refreshCount = 0;
            guideRefreshCount = 0;
            tunerHosts.length = 0;
            listingProviders.length = 0;
            timers.length = 0;
            return json({ ok: true });
        }

        // ライブTVの登録まわり。実 Jellyfin 10.11 のリクエスト/レスポンス形に合わせてある
        if (url.pathname === '/System/Configuration/livetv') {
            return json({ TunerHosts: tunerHosts, ListingProviders: listingProviders });
        }
        if (url.pathname === '/LiveTv/TunerHosts') {
            if (request.method === 'POST') {
                const body = (await request.json()) as Record<string, unknown>;
                const entry = { ...body, Id: `tuner-${nextId++}` };
                tunerHosts.push(entry);
                return json(entry);
            }
            if (request.method === 'DELETE') {
                const id = url.searchParams.get('id');
                const i = tunerHosts.findIndex((t) => t.Id === id);
                if (i >= 0) tunerHosts.splice(i, 1);
                return new Response(null, { status: 204 });
            }
        }
        if (url.pathname === '/LiveTv/ListingProviders') {
            if (request.method === 'POST') {
                const body = (await request.json()) as Record<string, unknown>;
                const entry = { ...body, Id: `listing-${nextId++}` };
                listingProviders.push(entry);
                return json(entry);
            }
            if (request.method === 'DELETE') {
                const id = url.searchParams.get('id');
                const i = listingProviders.findIndex((l) => l.Id === id);
                if (i >= 0) listingProviders.splice(i, 1);
                return new Response(null, { status: 204 });
            }
        }
        if (url.pathname === '/LiveTv/Timers') {
            return json({ Items: timers, TotalRecordCount: timers.length });
        }
        const timerPath = url.pathname.match(/^\/LiveTv\/Timers\/(.+)$/);
        if (timerPath !== null && request.method === 'DELETE') {
            const i = timers.findIndex((t) => t.Id === timerPath[1]);
            if (i >= 0) timers.splice(i, 1);
            return new Response(null, { status: 204 });
        }

        if (url.pathname === '/ScheduledTasks') {
            return json([{ Id: 'task-guide', Key: 'RefreshGuide', Name: 'Refresh Guide' }]);
        }
        if (url.pathname === '/ScheduledTasks/Running/task-guide' && request.method === 'POST') {
            guideRefreshCount++;
            return new Response(null, { status: 204 });
        }

        if (url.pathname === '/Library/Refresh' && request.method === 'POST') {
            refreshCount++;
            return new Response(null, { status: 204 });
        }

        return new Response('not found', { status: 404 });
    },
});

console.log(`fake jellyfin listening on :${PORT}`);
