/**
 * チューナーの取り合い。**エージェントの本体はここ。**
 *
 * mirakc がやっていた「誰にどのチューナーを渡すか」を引き取る。あちらとの違いは3つ。
 *
 * - **優先度に下限が無い。** `X-Mirakurun-Priority` は負値が 0 に丸められ、−1 は
 *   mirakc 自身の番組表集めに取られていた。ここは denpa が決めた数字がそのまま通る
 * - **番組表集めが特別扱いされない。** denpa から見れば録画もロゴも番組表も同じ
 *   「チャンネルを開きたい人」で、priority だけで並ぶ
 * - **同じ物理チャンネルなら1本で足りる。** 番組表・ロゴ・録画が同じ選局に相乗りする
 *
 * 選局そのものは `recisdb` を起こして標準出力を読む。**まだ開けっ放しにはしない** —
 * 掴んだままチャンネルを変えるには ioctl を直に叩く必要があり、それは
 * [roadmap.md](../docs/roadmap.md) の次の段階。ここまでで mirakc は要らなくなる。
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { resolveCommand } from './channels';

/** 止めるときの猶予。過ぎたら SIGKILL */
const KILL_GRACE = 3_000;

/**
 * 誰も読まなくなってから選局を畳むまでの間。
 *
 * **連続した番組を録るときに効く。** 前の録画が離してから次が開くまでの一瞬で
 * デバイスを閉じ直すと、まだ閉じきっていないところへ開きに行って弾かれる。
 * 掴んだままにしておけば、次の人はそのまま相乗りできる。
 */
const LINGER = 5_000;

/**
 * 読む側が遅れてよい上限 (バイト)。
 *
 * **録画は落とさない**方針なので、遅れは溜める。ただし際限なく溜めると
 * プロセスごと落ちるので、ここを超えたらその読み手だけ切る。切られた側は
 * 「録画に失敗した」と分かるほうが、黙って全部が死ぬよりまし。
 */
const MAX_LAG = 64 * 1024 * 1024;

export interface TunerSpec {
    name: string;
    types: string[];
    /** 選局に使うデバイス。ここからコマンドを組み立てる */
    device?: string;
    /** 衛星の給電。要る構成だけ (`15v` など) */
    lnb?: string;
    /**
     * 選局コマンドの上書き。**ファイルに直に書いたときだけ効く。**
     * 画面から自由な文字列を受けると、あちらで好きなコマンドが走ってしまう
     */
    command?: string;
    disabled?: boolean;
}

export interface OpenRequest {
    type: string;
    channel: string;
    /** 大きいほうが強い。低いものを蹴って割り込む */
    priority: number;
    /** 何のために開いたか。チューナー画面にそのまま出る */
    use: string;
}

export interface TunerStatus {
    index: number;
    name: string;
    types: string[];
    disabled: boolean;
    /** いま掴んでいるチャンネル。空いていれば null */
    channel: { type: string; channel: string } | null;
    /** 相乗りしている面々 */
    users: { use: string; priority: number }[];
    pid: number | null;
    /** 直前の選局が失敗した理由。アンテナやデバイスの当たりを付けるのに使う */
    error: string | null;
}

/** チューナーコマンドの `{{channel}}` を埋める。mirakc の書き方をそのまま受ける */
export function render(command: string, channel: string, type: string): string {
    const values: Record<string, string> = {
        channel,
        channel_type: type,
        duration: '-',
        extra_args: '',
    };
    return command.replace(/\{\{\{?\s*([a-z_]+)\s*\}?\}\}/g, (_, name: string) => values[name] ?? '');
}

/**
 * 選局コマンドを丸ごと終わらせる。
 *
 * **プロセスを1つ殺すだけでは足りない。** `sh -c` に渡すのがパイプラインだと、
 * sh を殺しても recisdb は生き残ってチューナーを掴んだままになり、次の
 * チャンネルが「デバイスが使用中」で失敗し続ける。プロセスグループごと落とす。
 */
export async function killTree(child: ChildProcess): Promise<void> {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const kill = (signal: NodeJS.Signals) => {
        try {
            // 負のPIDでプロセスグループ全体に送る (detached で起こしてある)
            process.kill(-(child.pid as number), signal);
        } catch {
            // もう居ない
        }
    };

    kill('SIGTERM');
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const gone = await Promise.race([exited.then(() => true), sleep(KILL_GRACE).then(() => false)]);
    if (gone) return;
    kill('SIGKILL');
    await Promise.race([exited, sleep(KILL_GRACE)]);
}

/** 1人の読み手。相乗りしているぶんだけ居る */
class Sink {
    controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    readonly stream: ReadableStream<Uint8Array>;

    constructor(
        readonly use: string,
        readonly priority: number,
        private readonly onLeave: (sink: Sink) => void,
    ) {
        this.stream = new ReadableStream<Uint8Array>(
            {
                start: (controller) => {
                    this.controller = controller;
                },
                cancel: () => {
                    this.controller = null;
                    this.onLeave(this);
                },
            },
            // 遅れを見るために長さで測る。既定の「個数で1つ」だと詰まりが分からない
            new ByteLengthQueuingStrategy({ highWaterMark: 4 * 1024 * 1024 }),
        );
    }

    /** @returns 遅れすぎて切ったら false */
    push(chunk: Uint8Array): boolean {
        if (this.controller === null) return true;
        try {
            this.controller.enqueue(chunk);
        } catch {
            // 相手が既に閉じている
            this.controller = null;
            this.onLeave(this);
            return true;
        }
        const desired = this.controller.desiredSize ?? 0;
        if (desired > -MAX_LAG) return true;
        this.fail(new Error('読み出しが追い付かないので切りました'));
        return false;
    }

    end(): void {
        const controller = this.controller;
        this.controller = null;
        try {
            controller?.close();
        } catch {
            // 既に閉じている
        }
    }

    fail(error: Error): void {
        const controller = this.controller;
        this.controller = null;
        try {
            controller?.error(error);
        } catch {
            // 既に閉じている
        }
        this.onLeave(this);
    }
}

/** 1本の選局。相乗りしている読み手をまとめて持つ */
class Lease {
    readonly sinks = new Set<Sink>();
    child: ChildProcess | null = null;
    /** 誰も居なくなってから畳むまでのタイマー */
    linger: ReturnType<typeof setTimeout> | null = null;
    error: string | null = null;
    /** 選局に失敗した理由を拾うため、stderr の末尾だけ持つ */
    private stderr = '';

    constructor(
        readonly tuner: number,
        readonly type: string,
        readonly channel: string,
    ) {}

    get priority(): number {
        let top = Number.NEGATIVE_INFINITY;
        for (const sink of this.sinks) top = Math.max(top, sink.priority);
        return top;
    }

    start(command: string, onExit: () => void): void {
        const child = spawn('sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        this.child = child;
        child.stdout?.on('data', (chunk: Buffer) => {
            const data = new Uint8Array(chunk);
            for (const sink of [...this.sinks]) {
                if (!sink.push(data)) this.sinks.delete(sink);
            }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            this.stderr = `${this.stderr}${chunk.toString()}`.slice(-2000);
        });
        const finish = () => {
            this.error = this.stderr.trim().split('\n').at(-1)?.trim() ?? null;
            onExit();
        };
        child.once('close', finish);
        child.once('error', (error) => {
            this.stderr = String(error);
            finish();
        });
    }
}

/**
 * チューナーを配る。
 *
 * 探す順番は「同じチャンネルに相乗り → 空いているチューナー → 自分より弱い相手を蹴る」。
 * **蹴られる側は録画かもしれない**ので、優先度は denpa 側で正しく付ける必要がある。
 */
export class TunerPool {
    /** チューナー番号 → いま掴んでいる選局 */
    private readonly leases = new Map<number, Lease>();

    constructor(
        private specs: TunerSpec[],
        private readonly onChange: () => void = () => {},
    ) {}

    get tuners(): TunerSpec[] {
        return this.specs;
    }

    /**
     * 機材の定義を入れ替える。**画面から書き換えたとき。**
     *
     * 走っている選局はそのまま続ける。名前が変わった・消えた本のものだけ、
     * 失敗として畳む — 掴んでいるデバイスが別物になったのに流し続けると、
     * 何が録れているのか分からなくなる。
     */
    replace(next: TunerSpec[]): void {
        const before = this.specs;
        this.specs = next;
        for (const [index, lease] of [...this.leases]) {
            if (before[index]?.name === next[index]?.name && next[index] !== undefined) continue;
            this.release(lease, 'チューナーの設定が変わりました');
        }
        this.onChange();
    }

    /**
     * 選局して読み口を返す。掴めなければ例外。
     *
     * 同じ物理チャンネルが既に開いていればそこへ混ぜる。**チューナーは増えない。**
     */
    open(request: OpenRequest): ReadableStream<Uint8Array> {
        const existing = this.find(request.type, request.channel);
        if (existing !== undefined) return this.join(existing, request);

        const index = this.pick(request);
        if (index === null) {
            throw new Error(`${request.type} のチューナーに空きがありません`);
        }

        // 蹴る相手が居れば先に片付ける。同じチューナーを2つの選局が掴まないように
        const victim = this.leases.get(index);
        if (victim !== undefined) this.release(victim, '優先度の高い要求に譲りました');

        const spec = this.specs[index];
        const lease = new Lease(index, request.type, request.channel);
        this.leases.set(index, lease);
        lease.start(render(resolveCommand(spec), request.channel, request.type), () => {
            // 選局が落ちた。読み手には失敗として伝える (黙って終わると空ファイルになる)
            if (this.leases.get(index) !== lease) return;
            this.leases.delete(index);
            const reason = lease.error === null ? '' : ` (${lease.error})`;
            for (const sink of lease.sinks) sink.fail(new Error(`選局が終了しました${reason}`));
            this.onChange();
        });
        this.onChange();
        return this.join(lease, request);
    }

    private join(lease: Lease, request: OpenRequest): ReadableStream<Uint8Array> {
        if (lease.linger !== null) {
            clearTimeout(lease.linger);
            lease.linger = null;
        }
        const sink = new Sink(request.use, request.priority, (leaving) => {
            lease.sinks.delete(leaving);
            if (lease.sinks.size === 0) this.scheduleRelease(lease);
            this.onChange();
        });
        lease.sinks.add(sink);
        this.onChange();
        return sink.stream;
    }

    private scheduleRelease(lease: Lease): void {
        if (lease.linger !== null) return;
        lease.linger = setTimeout(() => {
            lease.linger = null;
            if (lease.sinks.size === 0) this.release(lease, null);
        }, LINGER);
        lease.linger.unref?.();
    }

    private release(lease: Lease, reason: string | null): void {
        if (lease.linger !== null) clearTimeout(lease.linger);
        lease.linger = null;
        if (this.leases.get(lease.tuner) === lease) this.leases.delete(lease.tuner);
        for (const sink of lease.sinks) {
            if (reason === null) sink.end();
            else sink.fail(new Error(reason));
        }
        lease.sinks.clear();
        if (lease.child !== null) void killTree(lease.child);
        this.onChange();
    }

    private find(type: string, channel: string): Lease | undefined {
        for (const lease of this.leases.values()) {
            if (lease.type === type && lease.channel === channel) return lease;
        }
        return undefined;
    }

    /**
     * どのチューナーを使うか決める。
     *
     * 1. 空いているもの
     * 2. 誰も読んでいないもの (畳むのを待っているだけ)
     * 3. 自分より弱い相手が掴んでいるもの。いちばん弱いところから取る
     */
    private pick(request: OpenRequest): number | null {
        const usable = this.specs
            .map((spec, index) => ({ spec, index }))
            .filter(({ spec }) => spec.disabled !== true && spec.types.includes(request.type));

        for (const { index } of usable) {
            if (!this.leases.has(index)) return index;
        }
        for (const { index } of usable) {
            if (this.leases.get(index)?.sinks.size === 0) return index;
        }

        let weakest: { index: number; priority: number } | null = null;
        for (const { index } of usable) {
            const priority = this.leases.get(index)?.priority ?? Number.POSITIVE_INFINITY;
            if (priority >= request.priority) continue;
            if (weakest === null || priority < weakest.priority) weakest = { index, priority };
        }
        return weakest?.index ?? null;
    }

    status(): TunerStatus[] {
        return this.specs.map((spec, index) => {
            const lease = this.leases.get(index);
            return {
                index,
                name: spec.name,
                types: spec.types,
                disabled: spec.disabled === true,
                // 画面がそのまま編集できるように、定義もいっしょに返す
                device: spec.device ?? null,
                lnb: spec.lnb ?? null,
                // 直に書いた逃げ道。**画面からは触らせない** (読めるだけ)
                command: spec.command ?? null,
                channel: lease === undefined ? null : { type: lease.type, channel: lease.channel },
                users: [...(lease?.sinks ?? [])].map((sink) => ({
                    use: sink.use,
                    priority: sink.priority,
                })),
                pid: lease?.child?.pid ?? null,
                error: lease?.error ?? null,
            };
        });
    }

    /** 全部畳む。止めるときに使う */
    closeAll(): void {
        for (const lease of [...this.leases.values()]) this.release(lease, '停止します');
    }
}
