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
const AGENT_PORT = 25252;
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

/** 資格情報を持たずに叩く口。返るのは素の Response */
export type Anonymous = (path: string, init?: RequestInit) => Promise<Response>;

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

        const app = start(['bun', './server.js'], {
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

export interface OidcStack {
    /** 偽 Entra。`/__control/groups` で誰を通すか差し替えられる */
    idpUrl: string;
    /** OIDC を有効にした denpa。普段の `stack.appUrl` とは別の口 */
    appUrl: string;
    /** 何も聞かずに通す網 (TRUSTED_NETWORKS に入れてある) */
    trustedNetwork: string;
    clientId: string;
    group: string;
}

/**
 * **OIDC を有効にした一式を、要るテストのときだけ立てる。**
 *
 * 普段の `stack` を OIDC にしてしまうと、全部のテストがログインを通らないと
 * 何もできなくなる。別の口に立てて、そこだけで試す。
 *
 * 港はワーカーの帯 (STRIDE=10) の中から取るので、並べて流しても衝突しない。
 */
export async function bootOidc(
    index: number,
    root: string,
): Promise<{ oidc: OidcStack; shutdown: () => Promise<void> }> {
    const appPort = APP_PORT + index * STRIDE + 5;
    const idpPort = WEBHOOK_PORT + index * STRIDE + 5;
    const oidc: OidcStack = {
        idpUrl: `http://127.0.0.1:${idpPort}`,
        appUrl: `http://127.0.0.1:${appPort}`,
        trustedNetwork: '10.10.0.0/16',
        clientId: 'denpa-e2e',
        group: 'admins',
    };

    const started: Started[] = [];
    const shutdown = async () => {
        await Promise.all(started.map(stop));
    };

    try {
        const idp = start(['bun', 'tests/fake/idp.ts'], {
            FAKE_IDP_PORT: String(idpPort),
            FAKE_IDP_ISSUER: oidc.idpUrl,
            FAKE_IDP_GROUPS: oidc.group,
        });
        started.push(idp);
        await waitFor(`${oidc.idpUrl}/.well-known/openid-configuration`, idp, '偽 IdP');

        const app = start(['bun', './server.js'], {
            TZ: 'Asia/Tokyo',
            HOST: '127.0.0.1',
            PORT: String(appPort),
            /*
             * **ORIGIN は渡さない。** 渡すと adapter-node は Host ヘッダを見なくなり、
             * どの名前で来ても同じ origin として扱う。Entra へ送る戻り先
             * (`redirect_uri`) は**来たリクエストから組み立てる**ので、本番と同じく
             * リクエストごとのヘッダから決めさせる
             */
            PROTOCOL_HEADER: 'x-forwarded-proto',
            /*
             * **名前は `x-forwarded-host` から読ませる。** 本番は既定の `host` だが、
             * Node の fetch は `Host` を禁止ヘッダとして**黙って落とす**ので、
             * テストからは名前を差し替えられない (Bun の fetch は通す)。
             * denpa 側が見るのは `event.url.hostname` で、どちらのヘッダから
             * 組み立てられたかは同じなので、試している道は変わらない
             */
            HOST_HEADER: 'x-forwarded-host',
            DENPA_DB: `${root}/oidc.db`,
            RECORDED_DIR: `${root}/oidc-recorded`,
            LIBRARY_DIR: `${root}/oidc-library`,
            // 常駐処理は要らない。ログインの道だけ見る
            DENPA_AUTOSTART: '0',
            SHUTDOWN_WAIT: '0',
            OIDC_ISSUER: oidc.idpUrl,
            OIDC_CLIENT_ID: oidc.clientId,
            OIDC_CLIENT_SECRET: 'e2e-secret',
            OIDC_GROUP: oidc.group,
            // この網から来たら何も聞かない
            TRUSTED_NETWORKS: oidc.trustedNetwork,
            ADDRESS_HEADER: 'x-forwarded-for',
            BASIC_AUTH_USER: 'denpa',
            BASIC_AUTH_PASSWORD: 'ひみつ',
        });
        started.push(app);
        // 生死確認は守られていないので、ログインを通さずに待てる
        await waitFor(`${oidc.appUrl}/api/health`, app, 'denpa (OIDC)');
    } catch (error) {
        await shutdown();
        throw error;
    }

    return { oidc, shutdown };
}

/**
 * `stack` はワーカーに1つ。`auto` にしてあるので、明示的に受け取らないテストでも
 * 立ち上がった状態で始まる (`baseURL` がこれに乗っているため)。
 */
export const test = base.extend<{ anonymous: Anonymous }, { stack: Stack }>({
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

    /*
     * **資格情報を持たない口。** 断られることを確かめるためのもの。
     *
     * **Playwright の APIRequestContext は使えない。** `newContext` に資格情報を
     * 渡していなくても認証を通ってしまう — 実測で、素の fetch が 401 を返す同じ口に
     * 対して 200 が返った (`test.use({ httpCredentials: undefined })` でも同じ)。
     * 素の fetch なら確実に持たない。
     */
    anonymous: async ({ stack }, use) => {
        await use((path, init) => fetch(`${stack.appUrl}${path}`, { redirect: 'manual', ...init }));
    },
});

export { expect } from '@playwright/test';
