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

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type ChannelType, loadChannels, loadTuners, paths, saveChannels } from './channels';
import { CHANNEL_RANGES, channelsFor, Scanner } from './scan';
import { TunerPool } from './tuners';

const PORT = Number(process.env.AGENT_PORT ?? 40773);
/** denpa の生TSの置き場。掛かったままのTSは必ずここにある */
const RECORDED = resolve(process.env.RECORDED_DIR ?? '/denpa-recorded');
const RECISDB = process.env.RECISDB ?? 'recisdb';
const LOG_LIMIT = 400;

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

/**
 * 初回だけ雛形を置く。
 *
 * 設定は PVC に置いてあるので、イメージを入れ替えても手で書いたものは残る。
 * イメージ側のものを直に読ませると、**編集できない設定**になってしまう
 */
const TEMPLATE = '/app-config-defaults/tuners.yml';

function installTemplate(): void {
    if (existsSync(paths.tuners) || !existsSync(TEMPLATE)) return;
    mkdirSync(dirname(paths.tuners), { recursive: true });
    copyFileSync(TEMPLATE, paths.tuners);
    log(`チューナーの雛形を置きました: ${paths.tuners}`);
}

installTemplate();
const pool = new TunerPool(loadTuners(), () => emit('tuners'));

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

interface ScanState {
    state: 'idle' | 'running' | 'done' | 'failed' | 'canceled';
    phase: string;
    log: string[];
    scanned: number;
    total: number;
    channels: number;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
}

let scan: ScanState = {
    state: 'idle',
    phase: '',
    log: [],
    scanned: 0,
    total: 0,
    channels: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
};

function push(
    line?: string,
    counts: { scanned?: number; channels?: number; skipped?: number } = {},
    fields: Partial<ScanState> = {},
): void {
    scan = {
        ...scan,
        ...fields,
        log: line === undefined ? scan.log : [...scan.log, line].slice(-LOG_LIMIT),
        scanned: scan.scanned + (counts.scanned ?? 0) + (counts.skipped ?? 0),
        channels: scan.channels + (counts.channels ?? 0),
    };
    emit('scan');
}

/** 走っているスキャン。中断のために持っておく */
let scanner: Scanner | null = null;

async function runScan(targets: [ChannelType, string[]][]): Promise<void> {
    const running = new Scanner(pool, (progress) => push(progress.line, progress));
    scanner = running;
    try {
        push('チャンネルを探しています...', {}, { phase: 'スキャン中' });
        const found = await running.run(targets);

        /*
         * 中断されたら**何も書かない**。
         * 途中までの結果で上書きすると、まだ回っていない種別やチャンネルの
         * 定義が消える。押した人は「やめたい」だけで「消したい」ではない
         */
        if (running.aborted) {
            push('中断しました', {}, { state: 'canceled', phase: '中断', finishedAt: Date.now() });
            return;
        }

        // 1件も見つからないまま上書きすると、今まで録れていた局まで消える
        if (found.length === 0) {
            throw new Error('チャンネルが1件も見つかりませんでした。チューナーとアンテナを確認してください');
        }

        push('チャンネルを保存しています...', {}, { phase: '保存' });
        saveChannels(
            found,
            targets.map(([type]) => type),
        );
        push('完了しました', {}, { state: 'done', phase: '完了', finishedAt: Date.now() });
        /*
         * 局が入れ替わった。denpa は**これを合図に取り込み直す。**
         * mirakc を入れ直していた頃と違って、こちらは何も再起動しない —
         * 番組表を集めるのは denpa の仕事で、あちらが自分の都合で取りに行く
         */
        emit('channels');
    } catch (error) {
        push(`失敗しました: ${error}`, {}, { state: 'failed', error: String(error), finishedAt: Date.now() });
    } finally {
        scanner = null;
    }
}

function stopScan() {
    if (scan.state !== 'running' || scanner === null)
        return { stopped: false, message: '実行中ではありません' };
    scanner.stop();
    push('中断しています...', {}, { phase: '中断中' });
    return { stopped: true, message: 'チャンネルスキャンを中断しています' };
}

function startScan(body: { types?: unknown }) {
    const requested = Array.isArray(body.types) ? body.types : ['GR', 'BS', 'CS'];
    const types = requested.filter((type): type is ChannelType => type in CHANNEL_RANGES);
    if (types.length === 0) return { started: false, message: 'チャンネル種別の指定が不正です' };

    // 範囲は決め打ち。放送で使う物理チャンネルは決まっていて、狭めても
    // 総当たりの時間が少し減るだけ。狭めた結果 見つからない局が出るほうが困る
    const targets: [ChannelType, string[]][] = types.map((type) => [type, channelsFor(type)]);

    if (scan.state === 'running') return { started: false, message: '既に実行中です' };
    scan = {
        state: 'running',
        phase: '準備中',
        log: [],
        scanned: 0,
        total: targets.reduce((sum, [, channels]) => sum + channels.length, 0),
        channels: 0,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
    };
    void runScan(targets);
    return { started: true, message: 'チャンネルスキャンを始めました' };
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
            if (pathname === '/denpa/tuners') return json({ tuners: pool.status() });
            if (pathname === '/denpa/channels') return json(loadChannels());
            if (pathname === '/denpa/card' && request.method === 'GET') return json(await cardStatus());
            if (pathname === '/denpa/scan' && request.method === 'GET') return json(scan);
            if (pathname === '/denpa/decode' && request.method === 'POST') {
                const result = await decode(await request.json());
                return json(result, result.ok ? 200 : 500);
            }
            if (pathname === '/denpa/scan' && request.method === 'POST') {
                const result = startScan(await request.json());
                return json(result, result.started ? 200 : 409);
            }
            if (pathname === '/denpa/scan/stop' && request.method === 'POST') {
                const result = stopScan();
                return json(result, result.stopped ? 200 : 409);
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
