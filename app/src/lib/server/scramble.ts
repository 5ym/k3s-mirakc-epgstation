import { closeSync, openSync, readSync } from 'node:fs';
import { config } from './config';

/**
 * スクランブルの検出と解除。
 *
 * B-CASカードが読めないと recisdb は黙って復号せずに素通しする。録画は成功して
 * サイズもそれらしいのに、中身が全部スクランブルされていて ffmpeg が1フレームも
 * 取り出せない、という分かりにくい壊れ方をする。
 *
 * 録画そのものは止めない(電波は二度と戻ってこないので、暗号のままでも残す)。
 * 代わりにエンコードの前に見て、掛かったままならその場で解く。
 */

/** MPEG-TS のパケット長 */
const PACKET = 188;
const SYNC = 0x47;
/** 何パケット見るか。全部読むと数GBのTSで時間がかかる */
const SAMPLE = 20_000;
/** これを超えていたらスクランブルされているとみなす */
const THRESHOLD = 0.5;

/**
 * TS の中でスクランブルされているパケットの割合。
 *
 * transport_scrambling_control (4バイト目の上位2ビット) が立っているものを数える。
 * 正常なら 0 に近い。カードが読めていないと 98〜99% になる。
 */
export function scrambledRatio(path: string): number {
    let fd: number;
    try {
        fd = openSync(path, 'r');
    } catch {
        return 0;
    }

    try {
        const buffer = Buffer.alloc(PACKET * 1000);
        let total = 0;
        let scrambled = 0;
        let offset = 0;

        while (total < SAMPLE) {
            const read = readSync(fd, buffer, 0, buffer.length, offset);
            if (read < PACKET) break;
            offset += read;

            for (let i = 0; i + PACKET <= read; i += PACKET) {
                // 同期が取れていないファイルは判定しない。誤って解除に回すより素通しがまし
                if (buffer[i] !== SYNC) return 0;
                total++;
                if ((buffer[i + 3] & 0xc0) !== 0) scrambled++;
            }
        }
        return total === 0 ? 0 : scrambled / total;
    } finally {
        closeSync(fd);
    }
}

export function isScrambled(path: string): boolean {
    return scrambledRatio(path) > THRESHOLD;
}

/**
 * recisdb でスクランブルを解く。成功したら出力先のパスを返す。
 *
 * カードは Mirakurun 側の pcscd が握っている。その socket を共有しているので、
 * こちらは recisdb を呼ぶだけで読める。カードが無ければ失敗するので、
 * そのときは元のまま(スクランブルされたまま)エンコードに進んで失敗させる。
 */
export async function descramble(input: string, output: string): Promise<{ ok: boolean; error: string }> {
    const proc = Bun.spawn([config.recisdb, 'decode', '-i', input, output], {
        stdout: 'ignore',
        stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, error: stderr.trim().split('\n').slice(-5).join('\n') };
}
