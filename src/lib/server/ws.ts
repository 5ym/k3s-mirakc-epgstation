/**
 * WebSocket の受け口。**入口 (`server.js`) の `Bun.serve` に間借りする。**
 *
 * ライブ視聴は映像・音声・字幕・データ放送を1本の接続に多重化する作りなので
 * ([stream.md](../../../docs/stream.md) §5.3)、`Request` → `Response` では足りない。
 *
 * 枠の組み立て (RFC6455) も ping/pong も詰まり具合の面倒も **bun が見る**。
 * こちらが書くのは、多重化の頭を付けることと、誰に配るかだけ。
 *
 * ## なぜ入口が別に居るのか
 *
 * denpa は adapter-node で動いていて、そこは `node:http` の上にある。
 * **bun の `node:http` は WebSocket の握手ができない** — `upgrade` は上げるのに、
 * 渡される socket に書いても相手に1バイトも届かない (`write()` は true を返し、
 * コールバックも成功と言う。`_handle` が空)。実測で確かめた。
 *
 * `svelte-adapter-bun` に替える手も試したが、**今の SvelteKit では動かない**。
 * あちらは kit の生成物を正規表現で4か所書き換えて `websocket` フックを
 * 挿し込むのだが、`get_hooks` が別チャンクへ出るようになったため2か所が
 * 当たらず、`Bun.serve` に `websocket` が渡らない (実測。500 で落ちる)。
 *
 * そこで **`Bun.serve` を前に置き、WebSocket だけそこで受ける**。
 * それ以外は今までどおり adapter-node へ流すので、録画の配信も認証も
 * 止め方も1ミリも変わらない (`server.js`)。
 *
 * 入口はアプリの束の外に居るので直に import できない。`globalThis` 越しに渡す。
 */

import type { ServerWebSocket, WebSocketHandler } from 'bun';

/** 入口が見る名前。`server.js` と揃えること */
export const LIVE = '__denpaLive';

/**
 * 溜まってよい量。**これを超えたら映像は捨てる。**
 *
 * 放送は待ってくれないので、送りきれないぶんを積むと際限なく太る。
 * ライブは**遅れて全部届くより、飛んで今が映るほうがいい**。
 * init と制御は捨てない (捨てると以降ずっと絵が出ない)。
 */
const BACKLOG_LIMIT = 4 * 1024 * 1024;

/** 接続1本ぶんの持ち物。`server.upgrade()` に渡して `ws.data` になる */
export interface SocketData {
    url: URL;
    connection: Connection | null;
}

/** 開いている1本。**送るのは binary、受けるのは小さな指示だけ** */
export class Connection {
    /** ブラウザからの指示。JSON で解けなかったものは渡さない */
    onmessage: ((message: Record<string, unknown>) => void) | null = null;
    onclose: (() => void) | null = null;
    /** 捨てた数。詰まっているかを見るのに使う */
    dropped = 0;

    constructor(private readonly ws: ServerWebSocket<SocketData>) {}

    /**
     * 1つ送る。**多重化の頭を自分で付ける** (stream.md §5.3)。
     *
     *     [1 byte: 種別][8 bytes: PTS (90kHz, BE)][中身...]
     *
     * PTS は元TSの時間軸そのまま。字幕とデータ放送を映像と同じ物差しで
     * 並べるために要る (第2段階以降)。
     *
     * @param droppable 詰まっているときに捨ててよいか。映像の中身だけ true
     */
    send(kind: number, pts: bigint, payload: Uint8Array, droppable = false): void {
        if (droppable && this.ws.getBufferedAmount() > BACKLOG_LIMIT) {
            this.dropped++;
            return;
        }
        const out = new Uint8Array(9 + payload.length);
        out[0] = kind;
        new DataView(out.buffer).setBigUint64(1, pts);
        out.set(payload, 9);
        this.ws.sendBinary(out);
    }

    close(): void {
        this.ws.close();
    }

    /** bun から渡されたものを解く。**JSON 以外は黙って捨てる** */
    receive(message: string | Buffer): void {
        if (typeof message !== 'string') return;
        try {
            const parsed: unknown = JSON.parse(message);
            if (typeof parsed === 'object' && parsed !== null) {
                this.onmessage?.(parsed as Record<string, unknown>);
            }
        } catch {
            // 読めない指示は捨てる。切るほどのことではない
        }
    }

    finish(): void {
        this.onclose?.();
        this.onclose = null;
    }
}

interface Route {
    /**
     * 握手してよいか。**握手より前に呼ばれる。**
     *
     * ここで断れば普通の HTTP として返せるので、理由を伝えられる。
     * 握手したあとに切ると、ブラウザには「繋がらない」としか映らない。
     */
    accept(url: URL): boolean;
    open(connection: Connection, url: URL): void;
}

const routes = new Map<string, Route>();

/** この道に来た接続を受け持つ。ライブ視聴が `/api/live/socket` で登録する */
export function serve(pathname: string, route: Route): void {
    routes.set(pathname, route);
}

/**
 * 入口へ渡すもの。**遅延で引く。**
 *
 * `Bun.serve` は起動時にこれを1度だけ受け取るが、アプリが読み込まれるのは
 * そのあとになりうる。**入口側は毎回 `globalThis` を引き直す**ので、
 * ここに置くのは1回で足りる。
 */
export interface LiveEntry {
    /** そもそも受け持つ道か。**断り方を変えるために `accept` と分けてある** */
    handles(url: URL): boolean;
    /** 握手してよいか。ここで札を使い切る */
    accept(url: URL): boolean;
    websocket: WebSocketHandler<SocketData>;
}

const entry: LiveEntry = {
    handles(url) {
        return routes.has(url.pathname);
    },
    accept(url) {
        return routes.get(url.pathname)?.accept(url) === true;
    },
    websocket: {
        open(ws) {
            const route = routes.get(ws.data.url.pathname);
            if (route === undefined) {
                ws.close();
                return;
            }
            const connection = new Connection(ws);
            ws.data.connection = connection;
            route.open(connection, ws.data.url);
        },
        message(ws, message) {
            ws.data.connection?.receive(message);
        },
        close(ws) {
            ws.data.connection?.finish();
        },
    },
};

(globalThis as Record<string, unknown>)[LIVE] = entry;
