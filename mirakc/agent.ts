/**
 * チューナー側のエージェント。mirakc を抱えて、denpa の代わりにチューナーを触る。
 *
 * denpa からは触れないものが3つある。
 *
 * - B-CASカード … pcscd 経由でしか読めず、その pcscd はこのコンテナにしか居ない
 * - チューナーデバイス … スキャンは mirakc を通さず recisdb で直接叩く
 * - mirakc の設定 … config.yml は起動時にしか読まれないので、書いたら再起動が要る
 *
 * そのため mirakc の親としてこれが PID 1 になり、必要なときに mirakc を止めて
 * スキャンし、設定を書き戻してから起動し直す。
 */

import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseConfig, replaceChannels } from './config';
import {
    CHANNEL_RANGES,
    type ChannelEntry,
    type ChannelType,
    channelsFor,
    Scanner,
    type Tuner,
} from './scan';

const PORT = Number(process.env.AGENT_PORT ?? 40773);
/*
 * 設定は /etc/mirakc に置かない。あそこには mirakc 自身の strings.yml が居て、
 * PVC を被せると隠れてしまい mirakc が起動しなくなる
 */
const CONFIG = process.env.MIRAKC_CONFIG ?? '/app-config/config.yml';
const CONFIG_TEMPLATE = '/app-config-defaults/config.yml';
const EPG_CACHE = process.env.MIRAKC_EPG_CACHE ?? '/var/lib/mirakc/epg';
/** denpa の生TSの置き場。掛かったままのTSは必ずここにある */
const RECORDED = resolve(process.env.RECORDED_DIR ?? '/denpa-recorded');
const RECISDB = process.env.RECISDB ?? 'recisdb';
const MIRAKC = process.env.MIRAKC_BIN ?? '/usr/local/bin/mirakc';
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

/** mirakc の面倒を見る。落ちたら起こし、頼まれたら止める */
class Mirakc {
    private proc: Bun.Subprocess | null = null;
    /** 設定を置き終わるまで起動させない。設定が無いと mirakc は即死する */
    private wanted = false;

    begin(): void {
        this.wanted = true;
        void this.supervise();
    }

    private async supervise(): Promise<void> {
        for (;;) {
            if (this.wanted && this.proc === null) {
                this.proc = Bun.spawn([MIRAKC], { stdout: 'inherit', stderr: 'inherit' });
                log(`mirakc を起動しました (pid ${this.proc.pid})`);
            }
            const proc = this.proc;
            if (proc === null) {
                await Bun.sleep(500);
                continue;
            }
            await proc.exited;
            if (this.proc === proc) {
                this.proc = null;
                // 止めたのが自分なら黙って待つ。落ちたのなら起こし直す
                if (this.wanted) {
                    log('mirakc が落ちました。起こし直します');
                    await Bun.sleep(1000);
                }
            }
        }
    }

    async stop(): Promise<void> {
        this.wanted = false;
        const proc = this.proc;
        if (proc !== null) {
            proc.kill();
            await proc.exited;
        }
        log('mirakc を止めました');
    }

    start(): void {
        this.wanted = true;
    }

    get alive(): boolean {
        return this.proc !== null;
    }
}

const mirakc = new Mirakc();

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
}

function loadTuners(): Tuner[] {
    return parseConfig(readFileSync(CONFIG, 'utf8')).tuners ?? [];
}

/** 並べ替えの順。設定を読むときに種別ごとにまとまっているほうが分かりやすい */
const TYPE_ORDER: Record<string, number> = { GR: 0, BS: 1, CS: 2 };

/**
 * 見つけたチャンネルだけ差し替える。
 *
 * チューナーの定義はハードウェアの話で、スキャンで分かるものではない。
 * epg やサーバの設定ごと書き換えると、スキャンのたびに設定が飛ぶ。
 *
 * **探した種別だけ**を入れ替え、他はそのまま残す。地上波だけスキャンしたときに
 * 全部を置き換えると、BS と CS が設定から消える(実際に消して、BSの予約が
 * 録れなくなった)。
 */
function saveChannels(channels: ChannelEntry[], scanned: ChannelType[]): void {
    const source = readFileSync(CONFIG, 'utf8');
    const kept = (parseConfig(source).channels ?? []).filter((channel) => !scanned.includes(channel.type));
    const merged = [...kept, ...channels].sort(
        (a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.channel.localeCompare(b.channel),
    );
    const text = replaceChannels(source, merged);

    // 書きかけを読ませない。mirakc は起動時にしか読まないので、壊れたものを
    // 掴むと起動しなくなる
    const working = `${CONFIG}.writing`;
    writeFileSync(working, text);
    try {
        renameSync(working, CONFIG);
    } catch {
        // config.yml をファイル単位で bind mount していると差し替えられない
        // (compose の例がその形)。その場合は諦めて直接書く
        writeFileSync(CONFIG, text);
        rmSync(working, { force: true });
    }
}

/**
 * mirakc が覚えている局と時刻を捨てる。
 *
 * services.json などにスキャン前の局が残っていると、消えたはずの局が
 * 番組表に出続ける。次の起動で拾い直させる。
 */
function clearEpgCache(): void {
    if (!existsSync(EPG_CACHE)) return;
    for (const name of readdirSync(EPG_CACHE)) {
        rmSync(join(EPG_CACHE, name), { force: true });
    }
}

/** 走っているスキャン。中断のために持っておく */
let scanner: Scanner | null = null;

async function runScan(targets: [ChannelType, string[]][]): Promise<void> {
    const running = new Scanner(loadTuners(), (progress) => push(progress.line, progress));
    scanner = running;
    try {
        // 選局は mirakc を通さず recisdb を直接叩く。動かしたままだと EPG 更新と
        // チューナーの取り合いになるので、スキャンの間だけ止める
        push('mirakc を止めています...', {}, { phase: 'mirakc を停止' });
        await mirakc.stop();

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

        push('設定を書き込んでいます...', {}, { phase: '設定を反映' });
        saveChannels(
            found,
            targets.map(([type]) => type),
        );
        clearEpgCache();
        push('mirakc を起動しています...', {}, { state: 'done', phase: '完了', finishedAt: Date.now() });
    } catch (error) {
        push(`失敗しました: ${error}`, {}, { state: 'failed', error: String(error), finishedAt: Date.now() });
    } finally {
        scanner = null;
        // 中断しても失敗しても、mirakc は必ず戻す。止まったままだと録画も番組表も死ぬ
        mirakc.start();
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

export function serve(port = PORT): Bun.Server {
    return Bun.serve({
        port,
        hostname: '0.0.0.0',
        // スキャンは何十分もかかる。既定のまま切られると解除も途中で落ちる
        idleTimeout: 0,
        async fetch(request) {
            const { pathname } = new URL(request.url);

            if (pathname === '/denpa/card' && request.method === 'GET') return json(await cardStatus());
            if (pathname === '/denpa/scan' && request.method === 'GET') {
                return json({ ...scan, mirakc: mirakc.alive });
            }
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
    if (!existsSync(CONFIG) && existsSync(CONFIG_TEMPLATE)) {
        mkdirSync(dirname(CONFIG), { recursive: true });
        copyFileSync(CONFIG_TEMPLATE, CONFIG);
        log(`初期設定を置きました: ${CONFIG}`);
    }
    mkdirSync(EPG_CACHE, { recursive: true });

    if ((await run(['pgrep', '-x', 'pcscd'], 10_000)).code !== 0) {
        Bun.spawn(['pcscd', '--foreground', '--disable-polkit'], { stdout: 'ignore', stderr: 'ignore' });
        log('pcscd を起動しました');
    }

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, () => {
            void mirakc.stop().then(() => process.exit(0));
        });
    }

    mirakc.begin();
    serve();
    log(`listening on :${PORT} (recorded: ${RECORDED})`);
}
