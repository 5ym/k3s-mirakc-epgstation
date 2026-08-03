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

/**
 * これ以上がCM判定になったら、その結果は信じない。
 * 無音検出の既定 (cm.detectCmRanges の maxRatio) と同じ値にそろえてある
 */
const MAX_CM_RATIO = 0.5;

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

/** CM判定が占める割合 (%) */
export function cmRatio(cm: Range[], duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    const total = cm.reduce((sum, range) => sum + (range.end - range.start), 0);
    return Math.round((total / duration) * 100);
}

/**
 * CM判定が多すぎないか。
 *
 * ロゴを覚えたてのときなど、join_logo_scp が「頭の2秒だけ本編」のような結果を
 * 返すことがある。実機では30分アニメ2本が丸ごとCM扱いになっていた
 * (`Trim(0,59)` の1つだけ = CM 2秒〜1802秒)。
 * 無音検出と同じ判断にそろえてある。本編を削るよりCMが残るほうが被害が小さい
 */
export function tooMuchCm(cm: Range[], duration: number): boolean {
    return cmRatio(cm, duration) > MAX_CM_RATIO * 100;
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

/**
 * 覚えたロゴ (`.lgd`) の置き場。**局ごとに分ける。**
 *
 * logoframe は局名をファイル名に埋めて覚えるが、その名前は多バイト文字を
 * `_E7_B7_8F` のように潰したもので、こちらから組み立て直しても当たる保証がない。
 * 局ごとの入れ物にしておけば、位置を教え直したときに丸ごと捨てられる。
 *
 * **捨てられることが要る。** `-logo-area` はロゴを覚えるときにしか効かず、
 * 既に覚えているものがあれば合致率が落ちるまで作り直さない。実機では
 * TOKYO MX が「合致はしているのに結果の 100% がCM判定」のまま動かなくなり、
 * 位置を教えても覚えているほうが使われ続けていた。
 */
function logoRepo(serviceId: number | undefined): string {
    return serviceId === undefined ? config.jlsLogoDir : join(config.jlsLogoDir, String(serviceId));
}

/**
 * その局の覚えたロゴを捨てる。次のエンコードで、教えてもらった枠から覚え直す。
 * 覚え直しは録画1本ぶん余計にかかるが、当たらないまま回り続けるよりはいい
 */
export function forgetLogoData(serviceId: number): void {
    rmSync(logoRepo(serviceId), { recursive: true, force: true });
}

export interface JlsOptions {
    signal?: AbortSignal;
    /** 局名。logoframe に渡すとこの名前でロゴを覚える */
    channel?: string;
    /** 局のID。覚えたロゴの置き場を局ごとに分けるのに使う */
    serviceId?: number;
    /** 手で教えてもらったロゴの位置 ("x,y,w,h") */
    area?: string;
    /** いま何をしているか。数分かかる道具を3つ順に回すので、その都度伝える */
    onStep?: (label: string) => void;
}

export async function detectWithJls(
    input: string,
    duration: number,
    options: JlsOptions = {},
): Promise<{ cm: Range[]; note: string; logoMissing: boolean }> {
    const { signal, channel = '', serviceId, area = '', onStep } = options;
    const deadline = Date.now() + config.cmDetectTimeout;
    const step = onStep ?? (() => {});
    const work = workFiles(input);
    const bin = (name: string) => `${config.jlsBin}/${name}`;
    const repo = logoRepo(serviceId);
    mkdirSync(repo, { recursive: true });

    try {
        /*
         * 1. 局ロゴが写っているコマを拾う。
         *
         * 局名を渡すと logoframe が**その局のロゴデータ (.lgd) を自分で作って覚える**。
         * 1本目は作るぶん遅く、2本目からは使い回す。局が分からないときは
         * 持っているロゴを片端から当てる (無ければロゴ無しで進む)。
         *
         * **無音・シーンチェンジより先に回す。** 逆にしていた頃は、chapter_exe が
         * 落ちた録画ではロゴを当てられたかどうかが分からないまま無音検出に落ちていて、
         * 一覧に「ロゴを当てられませんでした」が出なかった (実機で2本)。
         * ロゴの当たり外れは局ごとに決まる話なので、先に確かめて必ず伝える
         */
        const logoArgs =
            channel === ''
                ? ['-logo', repo]
                : [
                      '-channel',
                      channel,
                      '-logo-dir',
                      repo,
                      '-logo-samples',
                      String(config.jlsLogoSamples),
                      // 自動で見つからなかった局だけ、画面から教わった範囲を渡す
                      ...(/^\d+,\d+,\d+,\d+$/.test(area) ? ['-logo-area', area] : []),
                  ];
        step('局ロゴが写っているコマを探しています');
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

        // 2. 無音とシーンチェンジを拾う
        step('無音とシーンの切れ目を探しています');
        const scenes = await run(
            [bin('chapter_exe'), '-v', input, '-s', '8', '-e', '4', '-o', work.scenes],
            signal,
            deadline,
        );
        if (scenes.code !== 0) {
            return { cm: [], note: failure('chapter_exe', scenes), logoMissing };
        }

        // 3. その2つを突き合わせて本編とCMに分ける
        step('本編とCMに分けています');
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

        // 番組の半分以上がCMになったら、その結果は捨てて無音検出に落とす (tooMuchCm)
        const cm = invertRanges(keep, duration);
        if (tooMuchCm(cm, duration)) {
            return {
                cm: [],
                note: `番組の ${cmRatio(cm, duration)}% がCMという結果だったので捨てました`,
                logoMissing,
            };
        }
        return { cm, note: 'join_logo_scp', logoMissing };
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

/**
 * 落ちた段階が分かるようにする。詳細に出して原因を追えるように。
 * 標準エラーは末尾だけ。TSの読み込み警告が延々と並ぶので、全部載せると読めない
 */
function failure(step: string, result: Step): string {
    return `${step} が失敗 (code ${result.code}): ${result.stderr.trim().split('\n').at(-1) ?? ''}`;
}
