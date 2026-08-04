/**
 * ARIB STD-B24 の8単位符号を読む。番組名・概要・局名はこの形で流れてくる。
 *
 * `psi.ts` が長らく「局名は読まない」で済ませていたところ。mirakc に頼っている
 * うちは向こうが読んでくれたが、番組表を自分で集めるなら避けて通れない
 * ([roadmap.md](../../../docs/roadmap.md))。
 *
 * ## 仕組み
 *
 * 符号表を4つ (G0〜G3) 持ち、**どの表を今使うか**を切り替えながら読む。
 * 0x21〜0x7E は GL に、0xA1〜0xFE は GR に割り当てられた表で引く。
 * SI の初期状態は G0=漢字 / G1=英数 / G2=ひらがな / G3=カタカナ、GL=G0・GR=G2。
 *
 * ## 漢字は EUC-JP に押し付ける
 *
 * 2バイトの漢字集合は JIS X 0208 そのもので、区点は (第1-0x20, 第2-0x20)。
 * **各バイトの最上位を立てれば EUC-JP になる**ので、変換表を抱え込まずに
 * `TextDecoder('euc-jp')` に渡せる。自前で持つのは規格の外にある外字だけ
 * ([aribtext-gaiji.ts](aribtext-gaiji.ts))。
 */

import { GAIJI } from './aribtext-gaiji';

/** 符号表の種類。バイト数と読み方だけ分かればいい */
interface Charset {
    bytes: 1 | 2;
    kind: 'kanji' | 'plane2' | 'symbol' | 'alnum' | 'hiragana' | 'katakana' | 'ank' | 'blank';
}

const KANJI: Charset = { bytes: 2, kind: 'kanji' };
const ALNUM: Charset = { bytes: 1, kind: 'alnum' };
const HIRAGANA: Charset = { bytes: 1, kind: 'hiragana' };
const KATAKANA: Charset = { bytes: 1, kind: 'katakana' };

/** 図形にしかならない集合 (モザイク・DRCS)。字数だけ数えて中身は出さない */
const MOSAIC: Charset = { bytes: 1, kind: 'blank' };

/**
 * 終端バイト → 符号表。ESC の指示で使う。
 *
 * モザイク (0x32〜0x35) は図形なので読めるものが無い。**捨てずに空へ倒す**のは、
 * 1バイト表として字数を数え続けないと以降がずれるため。
 *
 * **オブジェクトではなく Map。** 数値のキーは書式が10進に直されてしまい、
 * 規格に載っている終端バイトと突き合わせられなくなる (この下も同じ)。
 */
const CHARSETS = new Map<number, Charset>([
    [0x42, KANJI],
    [0x39, KANJI], // JIS互換漢字1面
    [0x3a, { bytes: 2, kind: 'plane2' }], // JIS互換漢字2面
    [0x3b, { bytes: 2, kind: 'symbol' }], // 追加記号
    [0x4a, ALNUM],
    [0x30, HIRAGANA],
    [0x31, KATAKANA],
    [0x49, { bytes: 1, kind: 'ank' }], // JIS X 0201 カタカナ (半角)
    [0x36, ALNUM], // プロポーショナル英数
    [0x37, HIRAGANA],
    [0x38, KATAKANA],
    [0x32, MOSAIC],
    [0x33, MOSAIC],
    [0x34, MOSAIC],
    [0x35, MOSAIC],
]);

/** 外字にも JIS にも無い文字を出すときの印。消すと題名から1文字黙って落ちる */
const UNKNOWN = '□';

/**
 * ひらがな・カタカナ表の末尾。**両方で共通**。
 *
 * 0x74〜0x76 は規格で未定義なので飛ばす (`undefined` のまま置いてある)。
 */
const KANA_TAIL = new Map<number, [string, string]>([
    [0x77, ['ゝ', 'ヽ']],
    [0x78, ['ゞ', 'ヾ']],
    [0x79, ['ー', 'ー']],
    [0x7a, ['。', '。']],
    [0x7b, ['「', '「']],
    [0x7c, ['」', '」']],
    [0x7d, ['、', '、']],
    [0x7e, ['・', '・']],
]);

const eucjp = new TextDecoder('euc-jp');
/**
 * 2バイト文字の変換結果を覚えておく。
 *
 * 番組表は同じ字が何万回も出てくるので、1文字ごとに `TextDecoder` を
 * 呼び直すと配列の確保だけで効いてくる。
 */
const cache = new Map<number, string>();

function twoByte(code: number, plane2: boolean): string {
    const cached = cache.get(code);
    if (cached !== undefined) return cached;

    const gaiji = GAIJI.get(code);
    const high = code >> 8;
    const low = code & 0xff;
    // EUC-JP は最上位を立てたもの。2面は 0x8F を頭に付ける
    const bytes = plane2
        ? Uint8Array.of(0x8f, high | 0x80, low | 0x80)
        : Uint8Array.of(high | 0x80, low | 0x80);
    const decoded = gaiji ?? eucjp.decode(bytes);
    // 変換できないと置換文字が返る。そのまま出すと題名に「�」が並ぶ
    const text = decoded === '' || decoded.includes('�') ? UNKNOWN : decoded;
    cache.set(code, text);
    return text;
}

/** C0 の制御符号が後ろに従える引数の数。ここを間違えると以降が全部ずれる */
const C0_PARAMS = new Map<number, number>([
    [0x16, 1], // PAPF
    [0x1c, 2], // APS
]);
/** C1 も同じ。COL/CDC は最初の引数が 0x20 のときだけもう1つ増える */
const C1_PARAMS = new Map<number, number>([
    [0x8b, 1], // SZX
    [0x90, 1], // COL
    [0x91, 1], // FLC
    [0x92, 1], // CDC
    [0x93, 1], // POL
    [0x94, 1], // WMM
    [0x97, 1], // HLC
    [0x98, 1], // RPC
    [0x9d, 2], // TIME
]);

/**
 * 8単位符号を読んで文字列にする。
 *
 * 壊れた並びで例外を投げない。放送波は落ちるもので、1つの記述子が読めなくても
 * 番組表全体を落とすほうが害が大きい。**読めたところまで返す。**
 */
export function decodeAribText(data: Uint8Array): string {
    const g: Charset[] = [KANJI, ALNUM, HIRAGANA, KATAKANA];
    let gl = 0;
    let gr = 2;
    /** 単発シフト (SS2/SS3)。1文字だけ別の表を使ったら元に戻す */
    let single: number | null = null;

    let out = '';
    let at = 0;

    /** ESC の指示先。0x28〜0x2B が G0〜G3 */
    const designate = (target: number, set: Charset | undefined) => {
        if (set !== undefined && target >= 0 && target <= 3) g[target] = set;
    };

    while (at < data.length) {
        const byte = data[at];

        // --- 制御符号 (C0) ------------------------------------------------
        if (byte <= 0x20 || byte === 0x7f || byte === 0xa0 || byte === 0xff) {
            at++;
            switch (byte) {
                case 0x0d: // APR。改行。直後の LF は同じ1回として畳む
                    out += '\n';
                    if (data[at] === 0x0a) at++;
                    break;
                case 0x0a: // APD。局によってはこちらで改行してくる
                    out += '\n';
                    break;
                case 0x20: // SP
                case 0xa0:
                    out += ' ';
                    break;
                case 0x0e: // LS1
                    gl = 1;
                    break;
                case 0x0f: // LS0
                    gl = 0;
                    break;
                case 0x19: // SS2
                    single = 2;
                    break;
                case 0x1d: // SS3
                    single = 3;
                    break;
                case 0x1b:
                    at = afterEscape(data, at, designate, (l, r) => {
                        if (l !== null) gl = l;
                        if (r !== null) gr = r;
                    });
                    break;
                default:
                    at += C0_PARAMS.get(byte) ?? 0;
                    break;
            }
            continue;
        }

        // --- 制御符号 (C1) ------------------------------------------------
        if (byte >= 0x80 && byte <= 0x9f) {
            at++;
            if (byte === 0x9b) {
                // CSI。引数のあと 0x40 以上の終端バイトが来るまで読み飛ばす
                while (at < data.length && data[at] < 0x40) at++;
                at++;
                continue;
            }
            if (byte === 0x95) {
                // MACRO。0x4F で終わる
                while (at < data.length && data[at] !== 0x4f) at++;
                at++;
                continue;
            }
            let params = C1_PARAMS.get(byte) ?? 0;
            // COL と CDC は「色を直に指定する」形のときだけ引数が1つ増える
            if ((byte === 0x90 || byte === 0x92) && data[at] === 0x20) params = 2;
            at += params;
            continue;
        }

        // --- 図形文字 ---------------------------------------------------
        const area = single !== null ? single : byte >= 0xa1 ? gr : gl;
        single = null;
        const set = g[area];
        const first = byte & 0x7f;

        if (set.bytes === 2) {
            const second = (data[at + 1] ?? 0) & 0x7f;
            at += 2;
            if (second < 0x21) continue;
            out += set.kind === 'blank' ? '' : twoByte((first << 8) | second, set.kind === 'plane2');
            continue;
        }

        at += 1;
        out += oneByte(first, set.kind);
    }

    return out;
}

function oneByte(code: number, kind: Charset['kind']): string {
    switch (kind) {
        case 'alnum':
            // 英数集合はそのまま ASCII として読める。全角に直すのは呼び出し側の仕事
            return String.fromCharCode(code);
        case 'hiragana':
            if (code <= 0x73) return String.fromCharCode(0x3041 + (code - 0x21));
            return KANA_TAIL.get(code)?.[0] ?? '';
        case 'katakana':
            if (code <= 0x76) return String.fromCharCode(0x30a1 + (code - 0x21));
            return KANA_TAIL.get(code)?.[1] ?? '';
        case 'ank':
            // JIS X 0201 の右半分。半角カナが U+FF61 から並んでいる
            return code <= 0x5f ? String.fromCharCode(0xff61 + (code - 0x21)) : '';
        default:
            // モザイクと DRCS。絵なので文字にはならないが、消えたことは見せる
            return kind === 'blank' ? '' : UNKNOWN;
    }
}

/**
 * ESC のあとを読む。**指示 (どの表を G0〜G3 に載せるか) と
 * 呼び出し (どの G を GL/GR に出すか) の2種類がある。**
 *
 * @returns 次に読むべき位置
 */
function afterEscape(
    data: Uint8Array,
    at: number,
    designate: (target: number, set: Charset | undefined) => void,
    invoke: (gl: number | null, gr: number | null) => void,
): number {
    const byte = data[at];
    if (byte === undefined) return at + 1;

    // 呼び出し。LS2/LS3 と、GR 側の LS1R/LS2R/LS3R
    const locking: Record<number, [number | null, number | null]> = {
        110: [2, null],
        111: [3, null],
        126: [null, 1],
        125: [null, 2],
        124: [null, 3],
    };
    const shift = locking[byte];
    if (shift !== undefined) {
        invoke(shift[0], shift[1]);
        return at + 1;
    }

    // 2バイト集合の指示。ESC 0x24 F は G0 への指示の略記
    if (byte === 0x24) {
        const next = data[at + 1];
        if (next === undefined) return at + 2;
        if (next >= 0x28 && next <= 0x2b) {
            // ESC 0x24 0x2x 0x20 F は2バイトDRCS。読めないので空へ倒す
            if (data[at + 2] === 0x20) {
                designate(next - 0x28, { bytes: 2, kind: 'blank' });
                return at + 4;
            }
            designate(next - 0x28, CHARSETS.get(data[at + 2]));
            return at + 3;
        }
        designate(0, CHARSETS.get(next));
        return at + 2;
    }

    // 1バイト集合の指示
    if (byte >= 0x28 && byte <= 0x2b) {
        const target = byte - 0x28;
        if (data[at + 1] === 0x20) {
            // 1バイトDRCS
            designate(target, { bytes: 1, kind: 'blank' });
            return at + 3;
        }
        designate(target, CHARSETS.get(data[at + 1]));
        return at + 2;
    }

    // 知らない指示。1バイトだけ飛ばして読み進める (止めるより取り返しがつく)
    return at + 1;
}
