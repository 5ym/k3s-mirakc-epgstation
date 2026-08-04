import { closeSync, openSync, readSync } from 'node:fs';
import { relative } from 'node:path';
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
 *
 * 解くのは mirakc 側。カードは pcscd 経由でしか読めず、その pcscd は
 * mirakc のコンテナに居る。socket を共有して denpa から直接読ませていたが
 * カードを開けないままだったので、カードを持っている側に頼む形にしてある
 * (mirakc/descrambler.mjs)。生TSの置き場は両方のコンテナに見せてあり、
 * やり取りするのはパスだけ。
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

export interface CardStatus {
    ok: boolean;
    /** 画面にそのまま出す一言 */
    message: string;
    readers: string[];
}

/**
 * カードリーダーの状態。設定画面に出す。
 *
 * pcscd が動いていてもリーダーを掴めていないことがある(USBが黙る)。
 * そうなると録画は成功したように見えて中身が全部スクランブルされたまま、という
 * 気づきにくい壊れ方をするので、画面から見えるようにしてある。
 */
export async function cardStatus(): Promise<CardStatus> {
    try {
        const res = await fetch(`${config.agentUrl}/denpa/card`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            return { ok: false, message: `解除の受け口が ${res.status} を返しました`, readers: [] };
        }
        const body = (await res.json()) as Partial<CardStatus>;
        return {
            ok: body.ok === true,
            message: body.message ?? '',
            readers: body.readers ?? [],
        };
    } catch (error) {
        return { ok: false, message: `解除の受け口に繋がりません: ${error}`, readers: [] };
    }
}

/**
 * スクランブルを解く。成功したら output に解けたTSが出来ている。
 *
 * 渡すのはパスだけで、TS そのものは流さない。生TSの置き場は mirakc 側にも
 * 見せてあるので、読むのも書くのも向こうが直接やる。数十GBになることがあり、
 * HTTP で往復させる意味が無い(そもそも Bun の fetch は送りながら受け取れず、
 * 大きいものを投げると詰まる)。
 *
 * recisdb はカードが読めないとき「黙って素通しする」ので、終了コードでは
 * 成否が分からない。出来上がったものを見て判断する。
 */
export async function descramble(
    input: string,
    output: string,
    signal?: AbortSignal,
): Promise<{ ok: boolean; error: string }> {
    /*
     * 向こうのマウント先はこちらと同じとは限らないので、生TSの置き場からの相対で渡す。
     * 掛かったままのTSは必ずここにある(引き継いだ録画も、移行のときに
     * 未エンコードのものは生TSとしてここへ入る)
     */
    const base = config.recordedDir;
    const from = relative(base, input);
    const to = relative(base, output);
    if (from.startsWith('..') || to.startsWith('..')) {
        return { ok: false, error: `生TSの置き場 (${base}) の外は解除に回せません` };
    }

    try {
        // 解除は数十分かかることがある。中止を押されたらここで切る
        const res = await fetch(`${config.agentUrl}/denpa/decode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: from, output: to }),
            signal,
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || body.ok !== true) {
            return { ok: false, error: body.error ?? `解除の受け口が ${res.status} を返しました` };
        }
    } catch (error) {
        return { ok: false, error: `解除の受け口に繋がりません: ${error}` };
    }

    if (isScrambled(output)) {
        // 素通しされた。ほぼカードが読めていない
        const card = await cardStatus();
        return { ok: false, error: `解除しても掛かったままです。${card.message}` };
    }
    return { ok: true, error: '' };
}
