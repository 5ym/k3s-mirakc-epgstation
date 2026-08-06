/**
 * 本番の入口。**WebSocket を受けるためだけに前に立つ。**
 *
 * ライブ視聴は映像・音声・字幕・データ放送を1本の接続に多重化する作りなので
 * ([docs/stream.md](docs/stream.md) §5.3)、`Request` → `Response` しか扱えない
 * SvelteKit の口では足りない。
 *
 * ## なぜ間に挟まるのか
 *
 * **bun の `node:http` は WebSocket の握手ができない。** `upgrade` は上がるのに、
 * 渡される socket に書いても相手に1バイトも届かない (`write()` は true を返し、
 * コールバックも成功と言う)。adapter-node はその上に居るので、そのままでは通らない。
 *
 * `svelte-adapter-bun` に替える手も試したが、**今の SvelteKit では動かない** —
 * kit の生成物を正規表現で書き換えて `websocket` フックを挿し込む作りで、
 * `get_hooks` が別チャンクへ出るようになったため当たらなくなっている
 * (実測。`To enable websocket support, set the "websocket" object` で 500)。
 *
 * ## 取るのは WebSocket だけ
 *
 * それ以外は内側の adapter-node へそのまま流す。**録画の配信 (Range 要求) も
 * 認証も SSE も、Pod 入れ替え時に録画が終わるまで居座る仕掛けも、あちらに
 * 乗っている**ので、触らないのがいちばん安い。中継は同じマシンの中の1ホップで、
 * 1人で使うものなので実質ただ (Range・SSE・POST とも通ることは実測済み)。
 *
 * **`Host` はそのまま渡す。** 書き換わると SvelteKit の CSRF 判定が自分の
 * origin と食い違い、フォーム送信が全部弾かれる。denpa は名前を2つ持っていて
 * `ORIGIN` で固定できないため、ここが効く (k3s/deployment.yaml)。
 */

/** `src/lib/server/ws.ts` が置く名前 */
const LIVE = '__denpaLive';

const publicPort = Number(process.env.PORT ?? 3000);
const publicHost = process.env.HOST ?? '0.0.0.0';

/**
 * 内側の adapter-node が待つところ。**127.0.0.1 だけ**に開くので、
 * 外から見える口は増えない。
 */
const innerPort = Number(process.env.DENPA_INNER_PORT ?? publicPort + 1);

// 内側へ渡す前に書き換える。adapter-node は読み込みの時点で環境変数を見る
process.env.PORT = String(innerPort);
process.env.HOST = '127.0.0.1';
await import('./build/index.js');
// こちらが公開する側なので、元に戻しておく (アプリが自分の口を見るとき用)
process.env.PORT = String(publicPort);
process.env.HOST = publicHost;

const inner = `http://127.0.0.1:${innerPort}`;

const upgrading = (request) =>
    request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
    request.headers.get('connection')?.toLowerCase().includes('upgrade') === true;

/** アプリが置いたもの。**毎回引き直す** — 読み込みが遅れることがある */
const live = () => globalThis[LIVE];

Bun.serve({
    port: publicPort,
    hostname: publicHost,
    // 映像を流し続けるので、無反応で切られては困る
    idleTimeout: 0,
    fetch(request, server) {
        const url = new URL(request.url);

        if (upgrading(request) && live()?.handles(url) === true) {
            /*
             * **断るのは握手の前。** ここなら普通の HTTP として理由を返せる。
             * 握手したあとに切ると、ブラウザには「繋がらない」としか映らない
             */
            if (!live().accept(url)) return new Response('ticket required', { status: 403 });
            const data = { url, connection: null };
            if (server.upgrade(request, { data })) return undefined;
            return new Response('upgrade failed', { status: 400 });
        }

        /*
         * **ヘッダはそのまま渡す。** `Host` も `Authorization` も `Range` も
         * `X-Forwarded-*` も、内側が見るものは全部あちらの流儀で解釈させる。
         *
         * **`Accept-Encoding` だけは外す。** ここの `fetch` は中継の途中で
         * 圧縮を勝手に展開するのに、`Content-Encoding: br` はそのまま透過する。
         * ブラウザは展開済みのものをもう一度 brotli として解こうとして失敗し、
         * **JS が1つも動かない** — 画面は SSR のぶんだけ出るのに、押しても
         * 何も起きない出方をする (E2E が50件落ちた)。
         *
         * 外しておけば内側は生で返すので、食い違いが起きない。無駄に
         * 圧縮して展開し直す往復も消える。**線の上での圧縮は前段に任せる**
         * (公開しているところは Traefik が居る)。
         */
        const headers = new Headers(request.headers);
        // **消すだけでは効かない。** `fetch` は無ければ自分で付け直すので、
        // 「圧縮しないでくれ」と明示する
        headers.set('accept-encoding', 'identity');

        return fetch(`${inner}${url.pathname}${url.search}`, {
            method: request.method,
            headers,
            body: request.body,
            redirect: 'manual',
        });
    },
    websocket: {
        open(ws) {
            live()?.websocket.open(ws);
        },
        message(ws, message) {
            live()?.websocket.message(ws, message);
        },
        close(ws, code, reason) {
            live()?.websocket.close(ws, code, reason);
        },
    },
});

console.log(`Listening on http://${publicHost}:${publicPort} (内側 ${inner})`);
