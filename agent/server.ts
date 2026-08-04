/**
 * チューナーエージェント。**機材に触るのはここだけ。**
 *
 * denpa から触れないものが3つある。
 *
 * - B-CASカード … pcscd 経由でしか読めず、その pcscd はこのコンテナにしか居ない
 * - チューナーデバイス … `/dev/dvb/*` が見えているのはこちらだけ
 * - 選局そのもの … `recisdb` を起こして標準出力を読む
 *
 * **中身は読まない。** NIT も SDT も EIT も解かず、TS をそのまま流す。
 * 読むのは denpa 側 (`src/lib/ts`) で、局を選り分けるのも番組表を組み立てるのも
 * あちらの仕事 ([roadmap.md](../docs/roadmap.md))。
 *
 * mirakc はもう抱えていない。取り合いも、どのチャンネルが使えるかも、ここが持つ。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    type ChannelEntry,
    type ChannelType,
    loadChannels,
    loadTuners,
    paths,
    saveChannels,
    saveTuners,
} from './channels';
import { TunerPool, type TunerSpec } from './tuners';

const PORT = Number(process.env.AGENT_PORT ?? 25252);
/** denpa の生TSの置き場。掛かったままのTSは必ずここにある */
const RECORDED = resolve(process.env.RECORDED_DIR ?? '/denpa-recorded');
const RECISDB = process.env.RECISDB ?? 'recisdb';

function log(message: string): void {
    console.log(`[agent] ${message}`);
}

/** 子プロセスを最後まで回して、出力をまとめて受け取る */
async function run(command: string[], timeout?: number): Promise<{ code: number; output: string }> {
    try {
        const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
        const stop = timeout === undefined ? undefined : setTimeout(() => proc.kill(), timeout);
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (stop !== undefined) clearTimeout(stop);
        return { code, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
        return { code: -1, output: String(error) };
    }
}

/*
 * 起きたことを知らせる口 (SSE)。denpa の画面がチューナーの様子を追うのに使う。
 * mirakc の `/events` に当たるが、流すのは**こちらが持っている事実だけ**
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

const pool = new TunerPool(loadTuners(), () => emit('tuners'));

/**
 * 機材の定義を書き換える。**画面から。**
 *
 * 受け取るのはデバイスと種別だけで、選局コマンドは組み立てる。自由な文字列を
 * 受けると「denpa に入れた人がチューナー側で好きなコマンドを走らせられる」
 * ことになる (しかもあちらは privileged)。
 */
function replaceTuners(body: { tuners?: unknown }) {
    if (!Array.isArray(body.tuners)) return { ok: false, error: 'tuners が要ります' };

    const next: TunerSpec[] = [];
    for (const item of body.tuners as Partial<TunerSpec>[]) {
        if (typeof item?.name !== 'string' || item.name === '') {
            return { ok: false, error: 'name の無いチューナーがあります' };
        }
        next.push({
            name: item.name,
            types: Array.isArray(item.types) ? item.types.filter((t) => typeof t === 'string') : [],
            disabled: item.disabled === true,
            device: typeof item.device === 'string' ? item.device : undefined,
            lnb: typeof item.lnb === 'string' && item.lnb !== '' ? item.lnb : undefined,
            // 画面から渡ってきたコマンドは捨てる。ファイルに直に書いたものだけ効く
        });
    }

    saveTuners(next);
    pool.replace(next);
    log(`チューナーの定義を保存しました: ${next.length} 本`);
    return { ok: true, error: '' };
}

/**
 * カードリーダーが見えているか。
 *
 * pcscd が動いていてもリーダーを掴めていないことがある(USBが黙る)。
 * そうなると recisdb は黙って復号せずに素通しし、録画は成功したように見えて
 * 中身が全部スクランブルされたまま、という分かりにくい壊れ方をする。
 */
async function cardStatus() {
    const pcscd = (await run(['pgrep', '-x', 'pcscd'], 10_000)).code === 0;
    const scan = await run(['pcsc_scan', '-r'], 15_000);
    // 「0: Reader name」の形で並ぶ
    const readers = scan.output
        .split('\n')
        .filter((line) => /^\s*\d+:\s/.test(line))
        .map((line) => line.trim().replace(/^\d+:\s*/, ''));

    const message = !pcscd
        ? 'pcscd が動いていません'
        : readers.length > 0
          ? `カードリーダーが見えています (${readers.length} 台)`
          : 'pcscd は動いていますが、カードリーダーが見つかりません';
    return { ok: pcscd && readers.length > 0, pcscd, readers, message };
}

/** 置き場の中に収まるパスだけ受け付ける。外を読み書きさせない */
function inside(name: unknown): string | null {
    if (typeof name !== 'string' || name === '') return null;
    const full = resolve(RECORDED, name);
    return full.startsWith(`${RECORDED}/`) ? full : null;
}

/**
 * 掛かったまま録れたTSを解く。
 *
 * recisdb はカードが読めないとき「黙って素通しする」ので、終了コードだけでは
 * 成否が分からない。出来上がったものを見て判断するのは呼び出し側(denpa)。
 */
async function decode(body: { input?: unknown; output?: unknown }) {
    const source = inside(body.input);
    const target = inside(body.output);
    if (source === null || target === null) {
        return { ok: false, error: `生TSの置き場の外は解除に回せません` };
    }
    if (!existsSync(source)) {
        return {
            ok: false,
            error: `${source} が見えません。denpa と同じ置き場をこのコンテナにも見せてください`,
        };
    }

    const { code, output } = await run([RECISDB, 'decode', '-i', source, target]);
    if (code !== 0) return { ok: false, error: `recisdb が ${code} で終了しました\n${output}` };
    return { ok: true, error: '' };
}

/**
 * チャンネルスキャンの結果を預かる。
 *
 * **書いてくるのは denpa。** 総当たりの選局はこちらに頼まれるが、NIT も SDT も
 * 解かないので「何が居たか」は分からない。読むのはあちらの仕事で、
 * こちらは控えを持って配るだけ ([roadmap.md](../docs/roadmap.md))。
 *
 * 保存したら `channels` を流す。**何も再起動しない** — 取り込み直すのも
 * 番組表を集め直すのも denpa が自分の都合でやる。
 */
function replaceChannels(body: { channels?: unknown; scanned?: unknown }) {
    const found = body.channels;
    const scanned = body.scanned;
    if (!Array.isArray(found) || !Array.isArray(scanned) || scanned.length === 0) {
        return { ok: false, error: 'channels と scanned が要ります', channels: [] as ChannelEntry[] };
    }
    // 1件も無いまま上書きすると、今まで録れていた局まで消える
    if (found.length === 0) {
        return { ok: false, error: 'チャンネルが1件もありません', channels: [] as ChannelEntry[] };
    }

    const merged = saveChannels(found as ChannelEntry[], scanned as ChannelType[]);
    log(`チャンネルを保存しました: ${found.length} 件 (${scanned.join(', ')})`);
    emit('channels');
    return { ok: true, error: '', channels: merged };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * 選局して TS を流す。**エージェントの表看板。**
 *
 * 素の TS をそのまま chunked で返す。何も包まないので
 * `curl --unix-socket ... > x.ts` で人手でも確かめられる。
 */
function openStream(url: URL, signal: AbortSignal): Response {
    const type = url.searchParams.get('type') ?? '';
    const channel = url.searchParams.get('channel') ?? '';
    if (type === '' || channel === '') return json({ error: 'type と channel が要ります' }, 400);

    try {
        const stream = pool.open({
            type,
            channel,
            priority: Number(url.searchParams.get('priority') ?? 0) || 0,
            use: url.searchParams.get('use') ?? '不明',
        });
        signal.addEventListener('abort', () => void stream.cancel().catch(() => undefined));
        return new Response(stream, { headers: { 'Content-Type': 'video/MP2T' } });
    } catch (error) {
        // 掴めなかった。**409 で返す**ので、呼んだ側は待って掛け直せる
        return json({ error: String(error) }, 409);
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

export function serve(port = PORT): Bun.Server {
    return Bun.serve({
        port,
        hostname: '0.0.0.0',
        // 選局は何時間も開きっぱなしになる。既定のまま切られると録画が落ちる
        idleTimeout: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const { pathname } = url;

            if (pathname === '/denpa/stream') return openStream(url, request.signal);
            if (pathname === '/denpa/events') return eventStream();
            if (pathname === '/denpa/tuners' && request.method === 'GET') {
                // bun 版は自分では探せない。書いてあるものだけ
                return json({ tuners: pool.status(), detected: false });
            }
            if (pathname === '/denpa/tuners' && request.method === 'PUT') {
                const result = replaceTuners(await request.json());
                return result.ok
                    ? json({ tuners: pool.status(), detected: false })
                    : json({ error: result.error }, 400);
            }
            if (pathname === '/denpa/channels' && request.method === 'GET') return json(loadChannels());
            if (pathname === '/denpa/channels' && request.method === 'PUT') {
                const result = replaceChannels(await request.json());
                return result.ok ? json(result.channels) : json({ error: result.error }, 400);
            }
            if (pathname === '/denpa/card' && request.method === 'GET') return json(await cardStatus());
            if (pathname === '/denpa/decode' && request.method === 'POST') {
                const result = await decode(await request.json());
                return json(result, result.ok ? 200 : 500);
            }
            return json({ ok: false, error: 'not found' }, 404);
        },
    });
}

if (import.meta.main) {
    if ((await run(['pgrep', '-x', 'pcscd'], 10_000)).code !== 0) {
        /*
         * **起こせなくても止まらない。** カードが読めなくても番組表もロゴも
         * 集まるし、掛かったままでも録っておくほうが録らないよりまし。
         * ここで落ちると「カードリーダーが無いから1本も録れない」になる
         */
        try {
            Bun.spawn(['pcscd', '--foreground', '--disable-polkit'], {
                stdout: 'ignore',
                stderr: 'ignore',
            });
            log('pcscd を起動しました');
        } catch (error) {
            log(`pcscd を起こせません (カードが要る録画は解除に失敗します): ${error}`);
        }
    }

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
            pool.closeAll();
            process.exit(0);
        });
    }

    serve();
    log(`listening on :${PORT} (tuners: ${paths.tuners} / channels: ${paths.channels})`);
    log(`チューナー ${pool.tuners.length} 本 / チャンネル ${loadChannels().length} 件`);
}
