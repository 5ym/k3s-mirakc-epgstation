import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Range } from './cm';
import { config } from './config';
import { text } from './stream';

/**
 * join_logo_scp (JLS) による CM 検出。
 *
 * Amatsukaze が高精度なのは、無音・シーンチェンジ(chapter_exe)に加えて
 * 「局ロゴが出ているか」(logoframe)を併用し、その2つを join_logo_scp で突き合わせて
 * 本編/CMを判定しているため。Amatsukaze 本体は Windows + AviSynth+ 前提で
 * Linux の Pod には載らないが、この検出核には Linux 移植がある。
 *
 * ここではその成果物である「Trim(開始フレーム,終了フレーム) の並んだ avs」だけを受け取り、
 * 秒の区間に直して silence 検出と同じ形で返す。エンコード自体は AviSynth を通さず
 * ffmpeg のままにしておきたいので、依存を検出フェーズだけに閉じ込める。
 *
 * 使うには以下がイメージ側に必要:
 *   - chapter_exe / logoframe / join_logo_scp (tobitti0 の Linux 移植)
 *   - AviSynth+
 *   - 局ごとのロゴデータ (.lgd)。これは自分の録画から作る必要がある
 */

const TRIM = /Trim\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;

/** avs の Trim(開始,終了) はフレーム番号かつ終端を含む。秒の半開区間に直す */
export function parseTrimRanges(avs: string, fps: number): Range[] {
    const ranges: Range[] = [];
    for (const match of avs.matchAll(TRIM)) {
        const from = Number(match[1]);
        const to = Number(match[2]);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
        ranges.push({ start: from / fps, end: (to + 1) / fps });
    }
    return ranges;
}

/** 残す区間(Trim)の裏返し = CM区間 */
export function invertRanges(keep: Range[], duration: number): Range[] {
    const sorted = [...keep].sort((a, b) => a.start - b.start);
    const cm: Range[] = [];
    let cursor = 0;
    for (const range of sorted) {
        if (range.start - cursor > 0.5) cm.push({ start: cursor, end: range.start });
        cursor = Math.max(cursor, range.end);
    }
    if (duration - cursor > 0.5) cm.push({ start: cursor, end: duration });
    return cm;
}

async function probeFps(input: string): Promise<number> {
    try {
        const proc = Bun.spawn(
            [
                config.ffprobe,
                '-v',
                'error',
                '-select_streams',
                'v:0',
                '-show_entries',
                'stream=avg_frame_rate',
                '-of',
                'default=nw=1:nk=1',
                input,
            ],
            { stdout: 'pipe', stderr: 'ignore' },
        );
        const out = (await text(proc.stdout as ReadableStream<Uint8Array>)).trim();
        await proc.exited;
        const [num, den] = out.split('/').map(Number);
        const fps = den ? num / den : num;
        if (Number.isFinite(fps) && fps > 0) return fps;
    } catch {
        // ffprobe が無い/失敗した場合は既定値に落とす
    }
    return config.cmJlsFallbackFps;
}

/** コマンドの出力から avs のパスを拾う。出力ディレクトリ指定があればそちらを優先して探す */
function findAvs(input: string, stdout: string): string | null {
    const fromStdout = stdout.match(/\S+\.avs/);
    if (config.cmJlsOutputDir === '') {
        return fromStdout === null ? null : fromStdout[0];
    }
    const stem = basename(input, extname(input));
    let newest: { path: string; mtime: number } | null = null;
    for (const name of readdirSync(config.cmJlsOutputDir)) {
        if (!name.endsWith('.avs') || !name.includes(stem)) continue;
        const path = join(config.cmJlsOutputDir, name);
        const mtime = statSync(path).mtimeMs;
        if (newest === null || mtime > newest.mtime) newest = { path, mtime };
    }
    return newest?.path ?? (fromStdout === null ? null : fromStdout[0]);
}

/**
 * logoframe が「ロゴの位置を決められなかった」と言っているか。
 *
 * 自動探索は「画面の隅にずっと同じ縁があること」を手がかりにするので、
 * 薄いロゴや動くロゴだと見つけられない。そのときは位置を人に教えてもらう
 * (録画の詳細から範囲を指定できる)。
 */
export function isLogoMissing(output: string): boolean {
    return /no persistent edge|uniform background|too few active pixels|logo file|-logo-area/i.test(output);
}

export async function detectWithJls(
    input: string,
    duration: number,
    signal?: AbortSignal,
    channel = '',
    area = '',
): Promise<{ cm: Range[]; note: string; logoMissing: boolean }> {
    /*
     * 局名を渡すと、logoframe が**その局のロゴデータを自分で作って覚える**。
     * 1本目は作るぶん遅く、2本目からは使い回す。渡さないとロゴ無しの判定になり、
     * 無音検出より少しましな程度まで精度が落ちる。
     *
     * 埋める値は単引用符でくくられる前提 (既定のコマンド)。番組名由来のパスにも
     * 局名にも空白は入るので、くくらないと引数が割れる。中の ' だけ落とす
     */
    const quote = (value: string) => value.replaceAll("'", '');
    const command = config.cmJlsCommand
        .replaceAll('{input}', quote(input))
        .replaceAll('{channel}', quote(channel))
        // 自動で見つからなかった局だけ、画面から教わった範囲を渡す
        .replaceAll('{area}', /^\d+,\d+,\d+,\d+$/.test(area) ? area : '');
    const proc = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });

    const timer = setTimeout(() => proc.kill(), config.cmDetectTimeout);
    // 実時間の数分の一かかる。中止を押されたら止める
    const kill = () => proc.kill();
    signal?.addEventListener('abort', kill, { once: true });
    const [stdout, stderr] = await Promise.all([
        text(proc.stdout as ReadableStream<Uint8Array>),
        text(proc.stderr as ReadableStream<Uint8Array>),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);

    // ロゴを当てられたかどうかは、CM が取れたかどうかとは別に伝える
    const logoMissing = isLogoMissing(stderr);

    if (code !== 0) {
        return {
            cm: [],
            note: `join_logo_scp が失敗 (code ${code}): ${stderr.slice(-500)}`,
            logoMissing,
        };
    }

    const avsPath = findAvs(input, stdout);
    if (avsPath === null) {
        return { cm: [], note: 'join_logo_scp の出力 avs が見つかりませんでした', logoMissing };
    }

    const keep = parseTrimRanges(readFileSync(avsPath, 'utf8'), await probeFps(input));
    if (keep.length === 0) {
        return { cm: [], note: `${avsPath} に Trim が含まれていませんでした`, logoMissing };
    }

    return { cm: invertRanges(keep, duration), note: 'join_logo_scp', logoMissing };
}
