#!/usr/bin/env node
/**
 * スクランブル解除の受け口。Mirakurun と同じコンテナで動かす。
 *
 * B-CASカードは pcscd 経由でしか読めず、その pcscd はこちら側に居る。
 * denpa 側にも socket を見せて recisdb を直接叩かせていたが、カードを
 * 開けないままだった。カードを持っている側で解くことにする。
 *
 * やり取りするのはパスだけで、TS そのものは流さない。生TSの置き場を
 * 両方のコンテナに見せてあるので、読むのも書くのも直接できる。
 * 数十GBになることがあり、HTTP で往復させる意味が無い。
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';

const PORT = Number(process.env.DESCRAMBLER_PORT ?? 40773);
const RECISDB = process.env.RECISDB ?? 'recisdb';
/** denpa の生TSの置き場。denpa 側の RECORDED_DIR と同じものを指す */
const RECORDED_DIR = resolve(process.env.RECORDED_DIR ?? '/denpa-recorded');

/** 子プロセスを最後まで回して、出力をまとめて受け取る */
function run(command, args) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(command, args);
        } catch (error) {
            resolve({ code: -1, output: String(error) });
            return;
        }
        let output = '';
        const collect = (chunk) => {
            output = (output + chunk).slice(-4000);
        };
        proc.stdout.on('data', collect);
        proc.stderr.on('data', collect);
        proc.on('error', (error) => resolve({ code: -1, output: String(error) }));
        proc.on('close', (code) => resolve({ code, output: output.trim() }));
    });
}

/** 生TSの置き場の中に収まるパスだけ受け付ける。外を読み書きさせない */
function inside(name) {
    if (typeof name !== 'string' || name === '') return null;
    const full = resolve(RECORDED_DIR, name);
    return full.startsWith(`${RECORDED_DIR}${sep}`) ? full : null;
}

/**
 * カードリーダーが見えているか。
 *
 * pcscd が動いていてもリーダーを掴めていないことがある(USBが黙る)。
 * そうなると recisdb は黙って復号せずに素通しし、録画は成功したように見えて
 * 中身が全部スクランブルされたまま、という分かりにくい壊れ方をする。
 */
async function card() {
    const pcscd = await run('pgrep', ['-x', 'pcscd']);
    const scan = await run('pcsc_scan', ['-r']);
    const readers = scan.output
        .split('\n')
        .map((line) => line.trim())
        // 「0: Reader name」の形で並ぶ
        .filter((line) => /^\d+:\s/.test(line))
        .map((line) => line.replace(/^\d+:\s*/, ''));

    const running = pcscd.code === 0;
    const found = readers.length > 0;
    return {
        ok: running && found,
        pcscd: running,
        readers,
        message: !running
            ? 'pcscd が動いていません'
            : found
              ? `カードリーダーが見えています (${readers.length} 台)`
              : 'pcscd は動いていますが、カードリーダーが見つかりません',
    };
}

/**
 * TS を1本解く。
 *
 * recisdb はカードが読めないとき「黙って素通しする」ので、終了コードだけでは
 * 成否が分からない。出来上がったものを見て判断するのは呼び出し側(denpa)。
 */
async function decode(body) {
    const input = inside(body.input);
    const output = inside(body.output);
    if (input === null || output === null) {
        return { ok: false, error: `生TSの置き場 (${RECORDED_DIR}) の外は解除に回せません` };
    }
    if (!existsSync(input)) {
        return {
            ok: false,
            error: `${input} が見えません。denpa と同じ生TSの置き場をこのコンテナにも見せてください`,
        };
    }

    const result = await run(RECISDB, ['decode', '-i', input, output]);
    if (result.code !== 0) {
        return { ok: false, error: `recisdb が ${result.code} で終了しました\n${result.output}` };
    }
    return { ok: true, error: '' };
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let text = '';
        req.on('data', (chunk) => {
            text += chunk;
            // パスしか来ないので、それ以上溜まるのは何かがおかしい
            if (text.length > 64 * 1024) reject(new Error('body too large'));
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(text));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];

    if (path === '/denpa/card' && req.method === 'GET') {
        card().then((body) => send(res, 200, body));
        return;
    }
    if (path === '/denpa/decode' && req.method === 'POST') {
        readJson(req)
            .then(decode)
            .then((body) => send(res, body.ok ? 200 : 500, body))
            .catch((error) => send(res, 400, { ok: false, error: String(error) }));
        return;
    }

    send(res, 404, { ok: false, error: 'not found' });
}).listen(PORT, '0.0.0.0', () => {
    console.log(`[descrambler] listening on :${PORT} (recorded: ${RECORDED_DIR})`);
});
