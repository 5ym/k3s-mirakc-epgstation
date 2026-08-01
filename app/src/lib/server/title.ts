/**
 * 番組名からシリーズ名とサブタイトルを切り出す。
 *
 * ライブラリでは「シリーズ名のフォルダ + 日付ベースのエピソード」として並べたいので、
 * 毎回変わる部分(話数・サブタイトル)を番組名から落として安定したシリーズ名を作るのが目的。
 * 放送局ごとに表記が揺れるため完璧は狙わず、実害の出やすいパターンだけ潰す。
 */

// 【新】【終】[字][解][再] のような装飾記号。先頭・末尾どこにでも出る
const DECORATION = /[【[(]\s*(新|終|再|字|解|デ|二|多|SS|初|最終回|無料|生|映)\s*[】\])]/g;

// 「サブタイトル」形式。番組名の末尾に出てきたものだけをサブタイトル扱いにする
const BRACKET_SUBTITLE = /[「『](.+?)[」』]\s*$/;

// #12 / 第12話 / ＃12 のような話数表記
const EPISODE = /\s*(?:#|＃|第)\s*(\d{1,4})\s*(?:話|回)?/;

// ファイル名に使えない文字。制御文字は別途コードポイントで弾く
const FORBIDDEN = '/\\:*?"<>|';

/** 全角英数・記号を半角に寄せる。Mirakurun が返す局名/番組名は全角混じりで検索しづらい */
export function toHalfWidth(input: string): string {
    return input
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/　/g, ' ')
        .replace(/[！-／：-＠［-｀｛-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export interface ParsedTitle {
    series: string;
    subtitle: string;
    episode: number | null;
}

export function parseTitle(rawName: string): ParsedTitle {
    const name = toHalfWidth(rawName ?? '')
        .replace(DECORATION, '')
        .trim();

    let subtitle = '';
    let series = name;

    const bracket = series.match(BRACKET_SUBTITLE);
    if (bracket !== null) {
        subtitle = bracket[1].trim();
        series = series.slice(0, bracket.index).trim();
    }

    let episode: number | null = null;
    const ep = series.match(EPISODE);
    if (ep !== null) {
        episode = Number(ep[1]);
        // 話数以降(「番組名 #12 サブタイトル」の後半)はサブタイトル扱いにして series からは落とす
        const tail = series.slice((ep.index ?? 0) + ep[0].length).trim();
        if (subtitle === '' && tail !== '') subtitle = tail;
        series = series.slice(0, ep.index).trim();
    }

    // 区切り記号だけが残るケース (「番組名 - 」など) を掃除する
    series = series.replace(/[\s\-~〜:：|｜]+$/, '').trim();
    if (series === '') series = name === '' ? 'untitled' : name;

    return { series, subtitle, episode };
}

/**
 * ファイル名・ディレクトリ名に使える形に落とす。
 * ext4 で壊れるのは `/` と NUL だけだが、SMB 経由で覗くことを考えて Windows の禁止文字も落とす。
 */
export function sanitizeFileName(input: string): string {
    const replaced = Array.from(input ?? '')
        .map((c) => (c.codePointAt(0)! < 0x20 || FORBIDDEN.includes(c) ? ' ' : c))
        .join('');
    const cleaned = replaced
        .replace(/\s+/g, ' ')
        .trim()
        // 末尾のドット・スペースは Windows が扱えない
        .replace(/[\s.]+$/, '');
    // ext4 のファイル名上限は255バイト。日本語(UTF-8で3バイト)でも収まる長さに切る
    const limited = cleaned.slice(0, 60).trim();
    return limited === '' ? 'untitled' : limited;
}
