#!/usr/bin/env bun
/**
 * 偽 recisdb。いまのところ `decode` だけ。
 *
 * 本物の復号はせず、4バイト目の transport_scrambling_control を落とす。
 * エージェントは終了コードしか見ない (素通しされたかどうかを見るのは denpa 側)
 * ので、それで筋は通る。
 *
 *     recisdb decode -i <入力> <出力>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] !== 'decode') {
    process.stderr.write(`fake recisdb: 知らないサブコマンドです: ${args[0]}\n`);
    process.exit(2);
}

const input = args[args.indexOf('-i') + 1];
const output = args.at(-1);
if (input === undefined || output === undefined || input === output) {
    process.stderr.write('fake recisdb: 入力と出力が要ります\n');
    process.exit(2);
}

try {
    const buffer = readFileSync(input);
    for (let i = 0; i + 188 <= buffer.length; i += 188) buffer[i + 3] &= 0x3f;
    writeFileSync(output, buffer);
} catch (error) {
    process.stderr.write(`fake recisdb: ${error}\n`);
    process.exit(1);
}
