/**
 * 偽 Jellyfin。
 *
 * 録画の削除は Jellyfin の UI からファイルを直接消す運用なので、denpa が Jellyfin に
 * 対してすることは「新しい録画を置いたのでスキャンして」と伝えるだけ。
 * そのぶんこの偽物も /Library/Refresh を受けて数えるだけでよい。
 */
const PORT = Number(process.env.FAKE_JELLYFIN_PORT ?? 8096);

let refreshCount = 0;
let nextId = 1;
// denpa からの通知を受け取る先。テストで届いた内容を確かめる
const webhookCalls: Record<string, unknown>[] = [];
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
            return json({ refreshCount, folders, users, webhookCalls });
        }
        if (url.pathname === '/__control/reset' && request.method === 'POST') {
            refreshCount = 0;
            webhookCalls.length = 0;
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

        if (url.pathname === '/__control/webhook' && request.method === 'POST') {
            webhookCalls.push((await request.json()) as Record<string, unknown>);
            return json({ ok: true });
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

        if (url.pathname === '/Library/Refresh' && request.method === 'POST') {
            refreshCount++;
            return new Response(null, { status: 204 });
        }

        return new Response('not found', { status: 404 });
    },
});

console.log(`fake jellyfin listening on :${PORT}`);
