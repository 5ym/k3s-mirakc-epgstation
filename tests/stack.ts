import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { test as base } from '@playwright/test';

/**
 * ワーカーごとに1式ずつ、denpa と偽チューナーエージェント / 偽通知先を立てる。
 *
 * 以前は1つのアプリと1つのDBを全テストで共有していたので、直列に流すしかなかった。
 * 予約も録画もルールも同じ表に入るため、2つのテストが同時に動くと件数が合わない。
 *
 * ワーカーごとに**ポートも置き場もDBも別**にすれば、その制約が消えて素直に並べられる。
 * ファイル単位では今までどおり順番に流れる (`fullyParallel: false`) ので、
 * 1つのファイルの中でテストが前のテストの結果を当てにしている書き方はそのまま通る。
 */

/** 作業領域。global-setup で毎回まっさらにする */
export const TEST_ROOT = '/tmp/denpa-e2e';

/*
 * ワーカー番号ごとにずらす幅。
 * 10 ずつ空けておけば、あとで口を1つ2つ増やしても衝突しない
 */
const STRIDE = 10;
const APP_PORT = 4173;
const AGENT_PORT = 40773;
const WEBHOOK_PORT = 8096;

/** 立ち上がりを待つ上限。ここを短くすると混んでいるマシンで落ちる */
const BOOT_TIMEOUT = 120_000;
const BOOT_POLL = 200;

export interface Stack {
    /** このワーカーの作業領域 */
    root: string;
    appUrl: string;
    agentUrl: string;
    webhookUrl: string;
    recordedDir: string;
    libraryDir: string;
    /** 引き継ぎ元。あえて作らずに始めて、マウント前後の見え方を試す */
    epgstationDir: string;
    /** これを置くと偽 ffmpeg がエンコードに失敗する */
    failFile: string;
}

interface Started {
    proc: ChildProcess;
    /** 立ち上がらなかったときに出す。何も出ないと原因が分からない */
    output: () => string;
}

function start(command: string[], env: Record<string, string>): Started {
    const proc = spawn(command[0], command.slice(1), {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const keep = (chunk: Buffer) => {
        log += chunk.toString();
        // 落ちたときの手掛かりが欲しいだけなので、後ろだけ持つ
        if (log.length > 20_000) log = log.slice(-20_000);
    };
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    return { proc, output: () => log };
}

async function waitFor(url: string, started: Started, what: string): Promise<void> {
    const until = Date.now() + BOOT_TIMEOUT;
    while (Date.now() < until) {
        if (started.proc.exitCode !== null) {
            throw new Error(`${what} が起動直後に終了しました:\n${started.output()}`);
        }
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch {
            // まだ待ち受けていない
        }
        await new Promise((resolve) => setTimeout(resolve, BOOT_POLL));
    }
    throw new Error(`${what} が ${url} で応答しませんでした:\n${started.output()}`);
}

async function stop(started: Started): Promise<void> {
    if (started.proc.exitCode !== null) return;
    started.proc.kill('SIGTERM');
    // SHUTDOWN_WAIT=0 なのですぐ止まる。それでも降りてこなければ叩き落とす
    const until = Date.now() + 5000;
    while (started.proc.exitCode === null && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (started.proc.exitCode === null) started.proc.kill('SIGKILL');
}

async function boot(index: number): Promise<{ stack: Stack; shutdown: () => Promise<void> }> {
    const appPort = APP_PORT + index * STRIDE;
    const agentPort = AGENT_PORT + index * STRIDE;
    const webhookPort = WEBHOOK_PORT + index * STRIDE;

    const root = `${TEST_ROOT}/w${index}`;
    const stack: Stack = {
        root,
        appUrl: `http://127.0.0.1:${appPort}`,
        agentUrl: `http://127.0.0.1:${agentPort}`,
        webhookUrl: `http://127.0.0.1:${webhookPort}`,
        recordedDir: `${root}/recorded`,
        libraryDir: `${root}/library`,
        epgstationDir: `${root}/epgstation-recorded`,
        failFile: `${root}/fail-encode`,
    };

    rmSync(root, { recursive: true, force: true });
    mkdirSync(stack.recordedDir, { recursive: true });
    mkdirSync(stack.libraryDir, { recursive: true });

    const started: Started[] = [];
    const shutdown = async () => {
        await Promise.all(started.map(stop));
    };

    try {
        const agent = start(['bun', 'tests/fake/agent.ts'], {
            FAKE_AGENT_PORT: String(agentPort),
            // 尺は tests/fake/services.ts で局ごとに決めている
            FAKE_SLOTS: '30',
            // スクランブル解除はパスだけ受け取って直接ファイルを触る。
            // 本物でも denpa とエージェントの両方に同じ置き場を見せている
            RECORDED_DIR: stack.recordedDir,
            LIBRARY_DIR: stack.libraryDir,
        });
        started.push(agent);

        const webhook = start(['bun', 'tests/fake/webhook.ts'], {
            FAKE_WEBHOOK_PORT: String(webhookPort),
        });
        started.push(webhook);

        const app = start(['bun', './build/index.js'], {
            TZ: 'Asia/Tokyo',
            HOST: '127.0.0.1',
            PORT: String(appPort),
            /*
             * adapter-node は指定が無いと自分を https だと思い込む。
             * SvelteKit の CSRF 判定は Origin ヘッダと自分の origin を突き合わせるので、
             * 平文で叩いている POST が全部 403 になる (画面上は「押しても何も起きない」)
             */
            ORIGIN: stack.appUrl,
            DENPA_DB: `${root}/denpa.db`,
            // 明示的に切った中継だけを見たいので、アイドル回収は長めに
            LIVE_IDLE_TIMEOUT: '600000',
            RECORDED_DIR: stack.recordedDir,
            LIBRARY_DIR: stack.libraryDir,
            FFMPEG: './tests/fake/ffmpeg.sh',
            // 選局もスクランブル解除もスキャンも、窓口はここ1つ
            TUNER_AGENT_URL: stack.agentUrl,
            // 引き継ぎ画面。何も待ち受けていない先を指して、失敗したときの見え方も試す
            EPGSTATION_RECORDED_DIR: stack.epgstationDir,
            EPGSTATION_DB_HOST: '127.0.0.1',
            EPGSTATION_DB_PORT: '1',
            FAKE_FFMPEG_FAIL_FILE: stack.failFile,
            // 定期処理は止め、テストからボタン/APIで明示的に走らせる(タイミング依存を避ける)
            RECONCILE_INTERVAL: '86400000',
            EPG_COLLECT_INTERVAL: '86400000',
            CHANNEL_SYNC_INTERVAL: '86400000',
            // 1チャンネル読むのに待つ上限。偽エージェントは開いた直後に全部流す
            EPG_CHANNEL_TIMEOUT: '10000',
            SCHEDULER_TICK: '500',
            START_MARGIN: '0',
            END_MARGIN: '500',
            // 録画が終わるまで待たれるとテストが終わらない
            SHUTDOWN_WAIT: '0',
            ENCODE_CONCURRENCY: '2',
            // ベーシック認証は設定画面から入れる。env は初期値として使えることの確認用
            BASIC_AUTH_USER: 'denpa',
            BASIC_AUTH_PASSWORD: 'ひみつ',
        });
        started.push(app);

        await Promise.all([
            waitFor(`${stack.agentUrl}/denpa/tuners`, agent, '偽エージェント'),
            waitFor(`${stack.webhookUrl}/__control/state`, webhook, '偽通知先'),
        ]);
        await waitFor(`${stack.appUrl}/api/health`, app, 'denpa');
    } catch (error) {
        await shutdown();
        throw error;
    }

    return { stack, shutdown };
}

/**
 * `stack` はワーカーに1つ。`auto` にしてあるので、明示的に受け取らないテストでも
 * 立ち上がった状態で始まる (`baseURL` がこれに乗っているため)。
 */
// biome-ignore lint/complexity/noBannedTypes: テスト単位で足すものは無い。Playwright の型引数は空で渡す
export const test = base.extend<{}, { stack: Stack }>({
    stack: [
        // biome-ignore lint/correctness/noEmptyPattern: Playwright は分割代入でないと受け付けない
        async ({}, use, workerInfo) => {
            const { stack, shutdown } = await boot(workerInfo.workerIndex);
            await use(stack);
            await shutdown();
        },
        { scope: 'worker', auto: true },
    ],
    // page.goto('/') や request.post('/api/sync') の宛先。ワーカーごとに違う
    baseURL: async ({ stack }, use) => {
        await use(stack.appUrl);
    },

    /*
     * API から直接投げるとき用。
     *
     * SvelteKit はフォーム形式の POST を Origin ヘッダで見ていて、付いていないものは
     * 「別のサイトからの送信」として断る。素の APIRequestContext は Origin を付けない
     * ので、フォームアクション (`?/reserve` など) が全部 403 になっていた。
     *
     * ブラウザ側には手を入れない。ブラウザは自分で正しい Origin を付ける
     */
    request: async ({ playwright, stack, httpCredentials }, use) => {
        const context = await playwright.request.newContext({
            baseURL: stack.appUrl,
            extraHTTPHeaders: { Origin: stack.appUrl },
            httpCredentials: httpCredentials ?? undefined,
        });
        await use(context);
        await context.dispose();
    },
});

export { expect } from '@playwright/test';
