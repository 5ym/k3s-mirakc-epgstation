/**
 * エージェントの適合テスト。**本物のエージェントを起こして、HTTP の口に直接当てる。**
 *
 * denpa の E2E は偽エージェント (`tests/fake/agent.ts`) を相手にしているので、
 * `server.ts` も取り合いも総当たりも1行も通っていなかった。ここがその穴を塞ぐ。
 *
 * **口に当てているので、中身が何語で書かれていても走る。** エージェントを
 * .NET に書き直したら、`AGENT_CMD` を差し替えて同じものを通す — それが
 * 「今までと同じように動く」の定義になる ([roadmap.md](../docs/roadmap.md))。
 *
 *     AGENT_CMD='./agent-dotnet/publish/denpa-agent' bun test agent/conformance.test.ts
 *
 * チューナーの代わりは `tests/fake/tune.ts`。エージェントから見れば
 * 「起こすと TS を流し続ける子プロセス」でしかないので、recisdb と区別がつかない。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SYNC } from '../src/lib/ts/psi';
import { channels } from '../tests/fake/broadcast';
import type { ChannelEntry } from './channels';

const AGENT_CMD = (process.env.AGENT_CMD ?? 'bun agent/server.ts').split(' ');
const PORT = Number(process.env.AGENT_TEST_PORT ?? 40881);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(import.meta.dir, '..');

/**
 * 地上波は**1本だけ**にしてある。
 *
 * 偽の放送に居る地上波は T16 と T21 の2本しかないので、チューナーが2本あると
 * 「空きが無い」も「弱い相手を蹴る」も作れない。総当たりが少し遅くなるだけで
 * 済むほうを取る。
 */
const TUNERS = `
tuners:
    - name: gr0
      types: [GR]
      command: bun ${ROOT}/tests/fake/tune.ts {{channel_type}} {{channel}}
    - name: bs0
      types: [BS, CS]
      command: bun ${ROOT}/tests/fake/tune.ts {{channel_type}} {{channel}}
    - name: bs1
      types: [BS, CS]
      command: bun ${ROOT}/tests/fake/tune.ts {{channel_type}} {{channel}}
    - name: off0
      types: [GR]
      disabled: true
      command: false
`;

let work: string;
let agent: Bun.Subprocess;
let log = '';

const paths = () => ({
    tuners: join(work, 'tuners.yml'),
    channels: join(work, 'channels.json'),
    recorded: join(work, 'recorded'),
});

const get = (path: string, signal?: AbortSignal) => fetch(`${BASE}${path}`, { signal });
const post = (path: string, body?: unknown) =>
    fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TunerStatus {
    name: string;
    types: string[];
    disabled: boolean;
    channel: { type: string; channel: string } | null;
    users: { use: string; priority: number }[];
}

async function tuners(): Promise<TunerStatus[]> {
    const body = (await (await get('/denpa/tuners')).json()) as { tuners: TunerStatus[] };
    return body.tuners;
}

interface Opened {
    status: number;
    reader?: ReadableStreamDefaultReader;
    /**
     * 読むのをやめる。**接続ごと切る。**
     *
     * `reader.cancel()` だけだと HTTP の接続は開いたままで、エージェントには
     * 「離した」が届かない (掴んだままになる)。本物の denpa も
     * `AbortController` で切っている
     */
    close: () => void;
}

/** 開けたものは全部覚えておく。テストが途中で落ちても後片付けできるように */
const opened = new Set<() => void>();

async function open(query: string): Promise<Opened> {
    const aborter = new AbortController();
    const close = () => {
        opened.delete(close);
        aborter.abort();
    };
    opened.add(close);
    const res = await get(`/denpa/stream?${query}`, aborter.signal);
    if (!res.ok || res.body === null) {
        close();
        return { status: res.status, close };
    }
    return { status: res.status, reader: res.body.getReader(), close };
}

/** 読み終わるまで待つ。蹴られたときは reason が入る */
async function drain(reader: ReadableStreamDefaultReader): Promise<{ bytes: number; error: string | null }> {
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return { bytes, error: null };
            bytes += (value as Uint8Array).byteLength;
        }
    } catch (error) {
        return { bytes, error: String(error) };
    }
}

beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'denpa-agent-'));
    mkdirSync(paths().recorded, { recursive: true });
    writeFileSync(paths().tuners, TUNERS);
    writeFileSync(paths().channels, JSON.stringify(channels(), null, 4));

    agent = Bun.spawn(AGENT_CMD, {
        cwd: ROOT,
        env: {
            ...process.env,
            AGENT_PORT: String(PORT),
            TUNERS_FILE: paths().tuners,
            CHANNELS_FILE: paths().channels,
            RECORDED_DIR: paths().recorded,
            // 復号は別プロセス。本物と同じく終了コードだけを見る
            RECISDB: `${ROOT}/tests/fake/recisdb.ts`,
            // 番組を作る本数。総当たりの1チャンネルあたりを軽くする
            FAKE_SLOTS: '4',
        },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    void (async () => {
        for await (const chunk of agent.stdout as ReadableStream<Uint8Array>) {
            log += new TextDecoder().decode(chunk);
        }
    })();
    void (async () => {
        for await (const chunk of agent.stderr as ReadableStream<Uint8Array>) {
            log += new TextDecoder().decode(chunk);
        }
    })();

    const until = Date.now() + 30_000;
    for (;;) {
        if (agent.exitCode !== null) throw new Error(`エージェントが起動直後に落ちました:\n${log}`);
        try {
            if ((await get('/denpa/tuners')).ok) break;
        } catch {
            // まだ待ち受けていない
        }
        if (Date.now() > until) throw new Error(`エージェントが応答しません:\n${log}`);
        await sleep(200);
    }
});

/**
 * 次のテストへ持ち越さない。
 *
 * 読むのをやめても、それが**エージェントに届くのは少しあと**になる (HTTP を
 * 1枚挟んでいるため)。掴んだままの状態で次のテストが始まると、取り合いの
 * 前提が崩れて何を見ているのか分からなくなる。
 *
 * 掴んでいるチャンネル自体は残ってよい — 誰も読まなくなってから5秒は
 * わざと離さない作りで、次に開く人はそこへ相乗りするのが正しい。
 */
afterEach(async () => {
    // 途中で落ちたテストの開きっぱなしも畳む
    for (const close of [...opened]) close();

    const until = Date.now() + 10_000;
    for (;;) {
        if (agent.exitCode !== null) throw new Error(`エージェントが落ちました:\n${log}`);
        const status = await tuners();
        if (status.every((tuner) => tuner.users.length === 0)) return;
        if (Date.now() > until) {
            throw new Error(`読み手が残っています: ${JSON.stringify(status.map((t) => t.users))}`);
        }
        await sleep(50);
    }
}, 20_000);

afterAll(async () => {
    agent?.kill();
    await agent?.exited;
    rmSync(work, { recursive: true, force: true });
});

describe('チューナー', () => {
    test('繋いである機材をそのまま出す', async () => {
        const status = await tuners();
        expect(status.map((t) => t.name)).toEqual(['gr0', 'bs0', 'bs1', 'off0']);
        expect(status[0].types).toEqual(['GR']);
        expect(status[3].disabled).toBe(true);
        expect(status.every((t) => t.users.length === 0)).toBe(true);
    });

    test('選局すると素のTSが流れてくる。何も包まない', async () => {
        const aborter = new AbortController();
        const res = await get('/denpa/stream?type=GR&channel=T16&use=test&priority=1', aborter.signal);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/MP2T');

        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const { value } = await reader.read();
        const chunk = value as Uint8Array;
        // 188バイト区切りの頭は必ず 0x47。ここが崩れていたら誰も読めない
        expect(chunk[0]).toBe(SYNC);
        expect(chunk.byteLength % 188).toBe(0);
        aborter.abort();
    });

    test('type と channel が無ければ 400', async () => {
        expect((await get('/denpa/stream?type=GR')).status).toBe(400);
    });

    test('用途と優先度がそのまま見える', async () => {
        const stream = await open('type=GR&channel=T16&use=rec%2012&priority=10');
        await stream.reader?.read();

        const gr = (await tuners())[0];
        expect(gr.channel).toEqual({ type: 'GR', channel: 'T16' });
        expect(gr.users).toEqual([{ use: 'rec 12', priority: 10 }]);
        stream.close();
    });

    /** **mirakc から引き取りたかったところ。** 同じ物理チャンネルなら選局は1本で足りる */
    test('同じチャンネルなら相乗りする。チューナーは増えない', async () => {
        const a = await open('type=GR&channel=T21&use=rec%201&priority=10');
        const b = await open('type=GR&channel=T21&use=epg%20T21&priority=3');
        await a.reader?.read();
        await b.reader?.read();

        const status = await tuners();
        expect(status[0].users.map((u) => u.use)).toEqual(['rec 1', 'epg T21']);
        // 空いているチューナーは掴まれていない
        expect(status[1].channel).toBeNull();

        a.close();
        b.close();
    });

    /**
     * **蹴られた側は、そこで読めなくなる。**
     *
     * ここで大事なのは「エラーとして伝わること」ではなく **「勝手には終わらない
     * ものが終わった」こと**。HTTP を1枚挟むと、送っている途中の
     * ReadableStream を `error()` にしても向こうには**正常終了として届く**
     * (Bun は残りの chunk を打ち切って畳むだけで、接続を壊さない)。
     *
     * なので口の約束はこうする — **選局は読み手が切るまで終わらない。**
     * 向こうから終わったなら、それは失敗である。読む側 (denpa) は EOF を
     * 「録り終えた」と読んではいけない。この約束なら .NET でも成り立つ
     */
    test('空きが無ければ弱い相手を蹴る。蹴られた側はそこで読めなくなる', async () => {
        const weak = await open('type=GR&channel=T16&use=logo&priority=1');
        await weak.reader?.read();
        const ended = drain(weak.reader as ReadableStreamDefaultReader);

        const strong = await open('type=GR&channel=T21&use=rec%201&priority=10');
        await strong.reader?.read();
        expect((await tuners())[0].channel).toEqual({ type: 'GR', channel: 'T21' });

        // 読めなくなること自体が合図。理由が付いていればなお良い
        const result = await Promise.race([ended, sleep(5000).then(() => null)]);
        expect(result).not.toBeNull();

        strong.close();
    });

    test('自分より強い相手しか居なければ 409 で断る', async () => {
        const strong = await open('type=GR&channel=T16&use=rec%201&priority=10');
        await strong.reader?.read();

        const weak = await open('type=GR&channel=T21&use=epg&priority=3');
        expect(weak.status).toBe(409);

        strong.close();
    });

    test('無効にしたチューナーは使わない', async () => {
        // GR で使えるのは gr0 だけ。off0 は無効なので、2本目は断られる
        const a = await open('type=GR&channel=T16&use=a&priority=5');
        await a.reader?.read();
        expect((await open('type=GR&channel=T21&use=b&priority=5')).status).toBe(409);
        expect((await tuners())[3].channel).toBeNull();
        a.close();
    });
});

describe('知らせ (SSE)', () => {
    test('チューナーが動くと tuners が飛ぶ', async () => {
        const aborter = new AbortController();
        const res = await get('/denpa/events', aborter.signal);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();

        const stream = await open('type=BS&channel=BS11_0&use=epg&priority=3');
        const { value } = await reader.read();
        expect(new TextDecoder().decode(value as Uint8Array)).toContain('event: tuners');

        stream.close();
        aborter.abort();
    }, 20_000);
});

describe('チャンネル', () => {
    test('スキャンの結果をそのまま返す', async () => {
        const found = (await (await get('/denpa/channels')).json()) as ChannelEntry[];
        expect(found.map((c) => c.channel).sort()).toEqual(['BS03_0', 'BS11_0', 'T16', 'T21']);
    });

    test('中断すると何も書かない', async () => {
        const before = readFileSync(paths().channels, 'utf8');
        expect((await post('/denpa/scan', { types: ['GR'] })).status).toBe(200);
        await sleep(300);
        expect((await post('/denpa/scan/stop')).status).toBe(200);

        const until = Date.now() + 60_000;
        for (;;) {
            const state = (await (await get('/denpa/scan')).json()) as { state: string };
            if (state.state !== 'running') {
                expect(state.state).toBe('canceled');
                break;
            }
            if (Date.now() > until) throw new Error('中断できませんでした');
            await sleep(200);
        }
        // 押した人は「やめたい」だけで「消したい」ではない
        expect(readFileSync(paths().channels, 'utf8')).toBe(before);
    });

    /**
     * 総当たりを本当に回す。**局名は SDT の ARIB 文字符号から読む** ので、
     * ここが通れば `ts/aribtext.ts` も `ts/psi.ts` も繋がっている
     */
    test('総当たりで局を見つけ、探した種別だけ差し替える', async () => {
        expect((await post('/denpa/scan', { types: ['GR'] })).status).toBe(200);

        const until = Date.now() + 180_000;
        for (;;) {
            const state = (await (await get('/denpa/scan')).json()) as {
                state: string;
                error: string | null;
            };
            if (state.state === 'done') break;
            if (state.state !== 'running') throw new Error(`スキャンが ${state.state}: ${state.error}`);
            if (Date.now() > until) throw new Error('スキャンが終わりませんでした');
            await sleep(500);
        }

        const found = JSON.parse(readFileSync(paths().channels, 'utf8')) as ChannelEntry[];
        const gr = found.filter((c) => c.type === 'GR');
        expect(gr.map((c) => c.channel)).toEqual(['T16', 'T21']);
        expect(gr[0].networkId).toBe(32391);
        expect(gr[0].services.map((s) => s.name)).toEqual(['ＭＸデータ１', 'ＴＯＫＹＯ　ＭＸ']);
        // 地上波だけ探したので、衛星はそのまま残っている
        expect(found.filter((c) => c.type === 'BS').map((c) => c.channel)).toEqual(['BS03_0', 'BS11_0']);
    }, 200_000);
});

describe('カードとスクランブル解除', () => {
    test('カードリーダーの様子を返す', async () => {
        const card = (await (await get('/denpa/card')).json()) as { ok: boolean; message: string };
        // 手元にリーダーは無い。**それでも答えは返る**ことが大事
        expect(typeof card.ok).toBe('boolean');
        expect(card.message.length).toBeGreaterThan(0);
    });

    test('置き場の外は解除に回さない', async () => {
        const res = await post('/denpa/decode', { input: '../../etc/passwd', output: 'x.ts' });
        expect(res.status).toBe(500);
        expect(((await res.json()) as { error: string }).error).toContain('置き場の外');
    });

    test('掛かったままのTSを解く', async () => {
        const packet = new Uint8Array(188 * 2);
        for (let i = 0; i < 2; i++) {
            packet[i * 188] = SYNC;
            packet[i * 188 + 3] = 0x90; // scrambling_control が立っている
        }
        writeFileSync(join(paths().recorded, 'in.ts'), packet);

        const res = await post('/denpa/decode', { input: 'in.ts', output: 'out.ts' });
        expect(res.status).toBe(200);
        const out = readFileSync(join(paths().recorded, 'out.ts'));
        expect(out[3] & 0xc0).toBe(0);
    });
});

test('知らない口は 404', async () => {
    expect((await get('/denpa/nope')).status).toBe(404);
});
