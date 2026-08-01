/**
 * 偽の通知先。
 *
 * denpa が Webhook を投げる相手。テストで「何が届いたか」を確かめるためだけのもので、
 * Discord や Slack の Incoming Webhook の代わりに立てる。
 */
const PORT = Number(process.env.FAKE_WEBHOOK_PORT ?? 8096);

const calls: Record<string, unknown>[] = [];

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/__control/state') return json({ webhookCalls: calls });
        if (url.pathname === '/__control/reset' && request.method === 'POST') {
            calls.length = 0;
            return json({ ok: true });
        }
        if (url.pathname === '/__control/webhook' && request.method === 'POST') {
            calls.push((await request.json()) as Record<string, unknown>);
            return json({ ok: true });
        }
        return new Response('not found', { status: 404 });
    },
});

console.log(`fake webhook listening on :${PORT}`);
