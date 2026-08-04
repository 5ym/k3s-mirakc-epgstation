/**
 * 偽の選局コマンド。**`recisdb tune` の代わり。**
 *
 * `tuners.yml` の `command` にこれを書くと、本物のエージェントを実チューナー無しで
 * 動かせる。エージェントから見れば「起こすと TS を標準出力に流し続ける子プロセス」
 * でしかないので、**取り合いも殺し方もスキャンも本物のまま**試せる。
 *
 *     bun tests/fake/tune.ts GR T16
 *
 * 受信できないチャンネルでは 1 で終わる。総当たりのスキャンは、この落ち方で
 * 「居ない」を判断する。
 *
 * つまみ (延長・スクランブル) は `FAKE_CONTROL` の JSON から都度読む。
 * 選局は別プロセスなので、テストからは書き換えるしかない。
 */
import { readFileSync } from 'node:fs';
import { broadcast, DEFAULT_KNOBS, type Knobs, on } from './broadcast';

const [type, channel] = process.argv.slice(2);
if (type === undefined || channel === undefined) {
    process.stderr.write('usage: tune.ts <type> <channel>\n');
    process.exit(2);
}

const services = on(type, channel);
if (services.length === 0) {
    // recisdb が電波を掴めなかったときと同じ形。スキャンはここを見て次へ行く
    process.stderr.write(`Cannot tune to ${channel}: no signal\n`);
    process.exit(1);
}

const CONTROL = process.env.FAKE_CONTROL;

function knobs(): Knobs {
    if (CONTROL === undefined) return DEFAULT_KNOBS;
    try {
        return { ...DEFAULT_KNOBS, ...(JSON.parse(readFileSync(CONTROL, 'utf8')) as Partial<Knobs>) };
    } catch {
        // まだ誰も書いていない
        return DEFAULT_KNOBS;
    }
}

const out = Bun.stdout.writer({ highWaterMark: 1 << 20 });
let closed = false;

const stop = broadcast(services, knobs, (data) => {
    if (closed || data.length === 0) return;
    try {
        out.write(data);
        out.flush();
    } catch {
        // 読み手が居なくなった (エージェントに殺された)。静かに畳む
        closed = true;
        stop();
    }
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
        stop();
        process.exit(0);
    });
}
