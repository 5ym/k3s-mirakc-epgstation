import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
 * 3つのコマンドは**ここから直接起動する**。以前はシェルスクリプトに逃がして
 * `sh -c` で呼んでいたが、番組名にも局名にも空白と引用符が入るので、
 * コマンド文字列を組み立てる限りどこかで引数が割れる。どの段階で落ちたのかも
 * 混ざった標準エラーから読み取るしかなかった。ffmpeg と同じように
 * 引数の配列で渡し、段階ごとに結果を見る。
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

interface Step {
    code: number;
    stderr: string;
}

/**
 * 1段階ぶん回す。
 *
 * どれも録画の実時間の数分の一かかる。中止を押されたら止め、
 * 全体の上限 (config.cmDetectTimeout) を超えたときも止める。
 */
async function run(argv: string[], signal: AbortSignal | undefined, deadline: number): Promise<Step> {
    const left = deadline - Date.now();
    if (left <= 0) return { code: 124, stderr: '時間切れ' };

    let proc: Bun.Subprocess;
    try {
        proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'pipe' });
    } catch (error) {
        // 一式が入っていないイメージもある。無音検出に落ちれば録画は続く
        return { code: 127, stderr: String(error) };
    }
    const timer = setTimeout(() => proc.kill(), left);
    const kill = () => proc.kill();
    signal?.addEventListener('abort', kill, { once: true });
    try {
        const stderr = await text(proc.stderr as ReadableStream<Uint8Array>);
        return { code: await proc.exited, stderr };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
    }
}

/**
 * 途中で作るファイルの共通の頭。入力の隣に置く (TSと同じ場所なら容量の心配が要らない)。
 *
 * 後始末はこの頭で拾って消す。logoframe は渡した名前のほかに
 * `_1.txt` や `_list.ini` を**自分で足して**作るので、こちらが名前を並べただけでは
 * 取りこぼす。実機の生TSの置き場に残骸が溜まっていた
 */
function workPrefix(input: string): string {
    return `${input}.jls`;
}

/** 途中で作るファイル。入力の隣に置く (TSと同じ場所なら容量の心配が要らない) */
function workFiles(input: string) {
    const base = workPrefix(input);
    return {
        /** chapter_exe が出す無音・シーンチェンジの一覧 */
        scenes: `${base}.chapterexe.txt`,
        /** logoframe が出す「ロゴが写っているコマ」の一覧 */
        frames: `${base}.logoframe.txt`,
        /** logoframe がついでに出すロゴ消しの avs。使わないが指定は要る */
        erase: `${base}.logoerase.avs`,
        /** join_logo_scp が出す「残す区間」の avs。これだけ読む */
        cut: `${base}.cut.avs`,
        /** join_logo_scp が出すシーン一覧。使わない */
        scpout: `${base}.jlscp.txt`,
    };
}

export async function detectWithJls(
    input: string,
    duration: number,
    signal?: AbortSignal,
    channel = '',
    area = '',
): Promise<{ cm: Range[]; note: string; logoMissing: boolean }> {
    const deadline = Date.now() + config.cmDetectTimeout;
    const work = workFiles(input);
    const bin = (name: string) => `${config.jlsBin}/${name}`;
    mkdirSync(config.jlsLogoDir, { recursive: true });

    try {
        // 1. 無音とシーンチェンジを拾う
        const scenes = await run(
            [bin('chapter_exe'), '-v', input, '-s', '8', '-e', '4', '-o', work.scenes],
            signal,
            deadline,
        );
        if (scenes.code !== 0) {
            return { cm: [], note: failure('chapter_exe', scenes), logoMissing: false };
        }

        /*
         * 2. 局ロゴが写っているコマを拾う。
         *
         * 局名を渡すと logoframe が**その局のロゴデータ (.lgd) を自分で作って覚える**。
         * 1本目は作るぶん遅く、2本目からは使い回す。局が分からないときは
         * 持っているロゴを片端から当てる (無ければロゴ無しで進む)。
         */
        const logoArgs =
            channel === ''
                ? ['-logo', config.jlsLogoDir]
                : [
                      '-channel',
                      channel,
                      '-logo-dir',
                      config.jlsLogoDir,
                      '-logo-samples',
                      String(config.jlsLogoSamples),
                      // 自動で見つからなかった局だけ、画面から教わった範囲を渡す
                      ...(/^\d+,\d+,\d+,\d+$/.test(area) ? ['-logo-area', area] : []),
                  ];
        const frames = await run(
            [bin('logoframe'), input, '-oa', work.frames, '-o', work.erase, ...logoArgs],
            signal,
            deadline,
        );
        // ロゴを当てられたかどうかは、CM が取れたかどうかとは別に伝える
        const logoMissing = isLogoMissing(frames.stderr);
        if (frames.code !== 0) {
            return { cm: [], note: failure('logoframe', frames), logoMissing };
        }

        // 3. その2つを突き合わせて本編とCMに分ける
        const joined = await run(
            [
                bin('join_logo_scp'),
                '-inlogo',
                work.frames,
                '-inscp',
                work.scenes,
                '-incmd',
                config.jlsRule,
                '-o',
                work.cut,
                '-oscp',
                work.scpout,
            ],
            signal,
            deadline,
        );
        if (joined.code !== 0) {
            return { cm: [], note: failure('join_logo_scp', joined), logoMissing };
        }

        let avs: string;
        try {
            avs = readFileSync(work.cut, 'utf8');
        } catch {
            return { cm: [], note: `${work.cut} が作られませんでした`, logoMissing };
        }

        const keep = parseTrimRanges(avs, await probeFps(input));
        if (keep.length === 0) {
            return { cm: [], note: `${work.cut} に Trim が含まれていませんでした`, logoMissing };
        }
        return { cm: invertRanges(keep, duration), note: 'join_logo_scp', logoMissing };
    } finally {
        // 中身は使い終わっている。録画の隣に置いているので残すと生TSの置き場を圧迫する
        cleanup(input);
    }
}

/**
 * 途中で作ったものを片付ける。
 *
 * 名前を並べて消すのではなく**頭で拾う**。logoframe は渡した名前に `_1.txt` や
 * `_list.ini` を自分で足して作るので、こちらが知っている名前だけでは取りこぼす。
 */
function cleanup(input: string): void {
    const prefix = workPrefix(input);
    const dir = dirname(prefix);
    const head = basename(prefix);
    try {
        for (const name of readdirSync(dir)) {
            if (name.startsWith(head)) rmSync(join(dir, name), { force: true });
        }
    } catch {
        // 置き場ごと消えていることもある。片付けで録画を止めない
    }
}

/** 落ちた段階が分かるようにする。詳細に出して原因を追えるように */
function failure(step: string, result: Step): string {
    return `${step} が失敗 (code ${result.code}): ${result.stderr.slice(-500)}`;
}
