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
// ライブラリ(VirtualFolders)とユーザー。denpa の初期セットアップの相手
const folders: Record<string, unknown>[] = [];
const users = [
    { Id: 'user-admin', Name: 'admin', Policy: { IsAdministrator: true, EnableContentDeletion: false } },
    { Id: 'user-guest', Name: 'guest', Policy: { IsAdministrator: false, EnableContentDeletion: false } },
];
const ADMIN = { name: 'admin', password: 'denpa-dev' };
const ISSUED_KEY = 'issued-by-denpa';

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/__control/state') {
            return json({
                refreshCount,
                guideRefreshCount,
                tunerHosts,
                listingProviders,
                timers,
                folders,
                users,
            });
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
            folders.length = 0;
            for (const u of users) u.Policy.EnableContentDeletion = false;
            return json({ ok: true });
        }

        // APIキーの発行。実 Jellyfin と同じく、ログイン -> キー作成 -> 一覧から拾う の3手
        if (url.pathname === '/Users/AuthenticateByName' && request.method === 'POST') {
            const body = (await request.json()) as { Username: string; Pw: string };
            if (body.Username !== ADMIN.name || body.Pw !== ADMIN.password) {
                return new Response('invalid', { status: 401 });
            }
            return json({ AccessToken: 'session-token', User: users[0] });
        }
        if (url.pathname === '/Auth/Keys') {
            if (request.method === 'POST') return new Response(null, { status: 204 });
            return json({
                Items: [{ AccessToken: ISSUED_KEY, AppName: url.searchParams.get('app') ?? 'denpa' }],
            });
        }

        if (url.pathname === '/Users') return json(users);
        const policy = url.pathname.match(/^\/Users\/([^/]+)\/Policy$/);
        if (policy !== null && request.method === 'POST') {
            const body = (await request.json()) as { EnableContentDeletion?: boolean };
            const user = users.find((u) => u.Id === policy[1]);
            if (user !== undefined) user.Policy.EnableContentDeletion = body.EnableContentDeletion === true;
            return new Response(null, { status: 204 });
        }

        if (url.pathname === '/Library/VirtualFolders') {
            if (request.method === 'GET') return json(folders);
            if (request.method === 'POST') {
                const body = (await request.json()) as { LibraryOptions: Record<string, unknown> };
                folders.push({
                    Name: url.searchParams.get('name'),
                    CollectionType: url.searchParams.get('collectionType'),
                    Locations: [url.searchParams.get('paths')],
                    ItemId: `folder-${nextId++}`,
                    LibraryOptions: body.LibraryOptions,
                });
                return new Response(null, { status: 204 });
            }
        }
        if (url.pathname === '/Library/VirtualFolders/Name' && request.method === 'POST') {
            const folder = folders.find((f) => f.Name === url.searchParams.get('name'));
            if (folder !== undefined) folder.Name = url.searchParams.get('newName');
            return new Response(null, { status: 204 });
        }
        if (url.pathname === '/Library/VirtualFolders/LibraryOptions' && request.method === 'POST') {
            const body = (await request.json()) as { Id: string; LibraryOptions: Record<string, unknown> };
            const folder = folders.find((f) => f.ItemId === body.Id);
            if (folder !== undefined) folder.LibraryOptions = body.LibraryOptions;
            return new Response(null, { status: 204 });
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
