/**
 * ARIB の符号を人が読める言葉に直す。
 *
 * EPG が持っているジャンルも音声の種別も番号でしかない。番組表の詳細で
 * 「アニメ／特撮 > 国内アニメ」「ステレオ (日本語)」と出すためだけの対応表。
 *
 * ブラウザ側でも使うのでサーバの機能には触れない。
 * 出典は ARIB STD-B10 第2部 (content_nibble / component_type)。
 */

/** ジャンル大分類。content_nibble_level_1 */
const GENRE_LV1: Record<number, string> = {
    0: 'ニュース／報道',
    1: 'スポーツ',
    2: '情報／ワイドショー',
    3: 'ドラマ',
    4: '音楽',
    5: 'バラエティ',
    6: '映画',
    7: 'アニメ／特撮',
    8: 'ドキュメンタリー／教養',
    9: '劇場／公演',
    10: '趣味／教育',
    11: '福祉',
    14: '拡張',
    15: 'その他',
};

/** ジャンル中分類。content_nibble_level_2。大分類ごとに意味が変わる */
const GENRE_LV2: Record<number, Record<number, string>> = {
    0: {
        0: '定時・総合',
        1: '天気',
        2: '特集・ドキュメント',
        3: '政治・国会',
        4: '経済・市況',
        5: '海外・国際',
        6: '解説',
        7: '討論・会談',
        8: '報道特番',
        9: 'ローカル・地域',
        10: '交通',
        15: 'その他',
    },
    1: {
        0: 'スポーツニュース',
        1: '野球',
        2: 'サッカー',
        3: 'ゴルフ',
        4: 'その他の球技',
        5: '相撲・格闘技',
        6: 'オリンピック・国際大会',
        7: 'マラソン・陸上・水泳',
        8: 'モータースポーツ',
        9: 'マリン・ウインタースポーツ',
        10: '競馬・公営競技',
        15: 'その他',
    },
    2: {
        0: '芸能・ワイドショー',
        1: 'ファッション',
        2: '暮らし・住まい',
        3: '健康・医療',
        4: 'ショッピング・通販',
        5: 'グルメ・料理',
        6: 'イベント',
        7: '番組紹介・お知らせ',
        15: 'その他',
    },
    3: { 0: '国内ドラマ', 1: '海外ドラマ', 2: '時代劇', 15: 'その他' },
    4: {
        0: '国内ロック・ポップス',
        1: '海外ロック・ポップス',
        2: 'クラシック・オペラ',
        3: 'ジャズ・フュージョン',
        4: '歌謡曲・演歌',
        5: 'ライブ・コンサート',
        6: 'ランキング・リクエスト',
        7: 'カラオケ・のど自慢',
        8: '民謡・邦楽',
        9: '童謡・キッズ',
        10: '民族音楽・ワールドミュージック',
        15: 'その他',
    },
    5: {
        0: 'クイズ',
        1: 'ゲーム',
        2: 'トークバラエティ',
        3: 'お笑い・コメディ',
        4: '音楽バラエティ',
        5: '旅バラエティ',
        6: '料理バラエティ',
        15: 'その他',
    },
    6: { 0: '洋画', 1: '邦画', 2: 'アニメ', 15: 'その他' },
    7: { 0: '国内アニメ', 1: '海外アニメ', 2: '特撮', 15: 'その他' },
    8: {
        0: '社会・時事',
        1: '歴史・紀行',
        2: '自然・動物・環境',
        3: '宇宙・科学・医学',
        4: 'カルチャー・伝統文化',
        5: '文学・文芸',
        6: 'スポーツ',
        7: 'ドキュメンタリー全般',
        8: 'インタビュー・討論',
        15: 'その他',
    },
    9: {
        0: '現代劇・新劇',
        1: 'ミュージカル',
        2: 'ダンス・バレエ',
        3: '落語・演芸',
        4: '歌舞伎・古典',
        15: 'その他',
    },
    10: {
        0: '旅・釣り・アウトドア',
        1: '園芸・ペット・手芸',
        2: '音楽・美術・工芸',
        3: '囲碁・将棋',
        4: '麻雀・パチンコ',
        5: '車・オートバイ',
        6: 'コンピュータ・TVゲーム',
        7: '会話・語学',
        8: '幼児・小学生',
        9: '中学生・高校生',
        10: '大学生・受験',
        11: '生涯教育・資格',
        12: '教育問題',
        15: 'その他',
    },
    11: {
        0: '高齢者',
        1: '障害者',
        2: '社会福祉',
        3: 'ボランティア',
        4: '手話',
        5: '文字(字幕)',
        6: '音声解説',
        15: 'その他',
    },
};

export interface Genre {
    lv1: number;
    lv2: number;
}

/**
 * ルールの条件に出すジャンルの一覧。予備(0xC/0xD)は放送に出てこないので載せない。
 *
 * 条件は文字列で持つ。`"7"` なら大分類だけ(アニメ／特撮すべて)、
 * `"7-0"` なら中分類まで(国内アニメだけ)。
 */
export const GENRE_TREE: {
    value: string;
    label: string;
    children: { value: string; label: string }[];
}[] = Object.entries(GENRE_LV1).map(([lv1, label]) => ({
    value: lv1,
    label,
    children: Object.entries(GENRE_LV2[Number(lv1)] ?? {}).map(([lv2, name]) => ({
        value: `${lv1}-${lv2}`,
        label: name,
    })),
}));

/** ルールの条件の値を人が読める名前に。`"7-0"` → 「アニメ／特撮 > 国内アニメ」 */
export function genreName(value: string | number): string {
    const [lv1, lv2] = String(value).split('-').map(Number);
    const head = GENRE_LV1[lv1];
    if (head === undefined) return String(value);
    if (Number.isNaN(lv2)) return head;
    return `${head} > ${GENRE_LV2[lv1]?.[lv2] ?? lv2}`;
}

/** ルールの条件に番組が当てはまるか。大分類だけの条件は中分類を問わない */
export function genreMatches(conditions: string[], genres: Genre[]): boolean {
    return genres.some((g) => conditions.includes(String(g.lv1)) || conditions.includes(`${g.lv1}-${g.lv2}`));
}

/** 「アニメ／特撮 > 国内アニメ」。中分類が引けなければ大分類だけ返す */
export function genreLabel(genre: Genre): string {
    const lv1 = GENRE_LV1[genre.lv1];
    if (lv1 === undefined) return '';
    const lv2 = GENRE_LV2[genre.lv1]?.[genre.lv2];
    return lv2 === undefined ? lv1 : `${lv1} > ${lv2}`;
}

/**
 * 音声の構成。component_type。
 * 2 のデュアルモノは主音声/副音声の切り替えがある放送で、
 * エンコードのときも扱いを変えている(encoder.ts)。
 */
const AUDIO_TYPE: Record<number, string> = {
    1: 'モノラル',
    2: 'デュアルモノ',
    3: 'ステレオ',
    4: '2/1',
    5: '3/0',
    6: '2/2',
    7: '3/1',
    8: '3/2',
    9: '5.1ch',
    10: '3/3.1',
    11: '2/0/0-2/0/2-0.1',
    12: '5/2.1',
    13: '3/2/2.1',
    14: '2/0/0-3/0/2-0.1',
    15: '0/2/0-3/0/2-0.1',
    16: '2/0/0-3/2/3-0.2',
    17: '3/3/3-5/2/3-3/0/0.2',
};

/** ISO 639-2 のうち日本の放送で出てくるもの */
const LANGUAGE: Record<string, string> = {
    jpn: '日本語',
    eng: '英語',
    deu: 'ドイツ語',
    fra: 'フランス語',
    ita: 'イタリア語',
    rus: 'ロシア語',
    zho: '中国語',
    kor: '韓国語',
    spa: 'スペイン語',
    por: 'ポルトガル語',
    tha: 'タイ語',
    etc: 'その他',
};

export interface Audio {
    componentType: number;
    langs?: string[];
    samplingRate?: number;
}

/** 「ステレオ (日本語)」「デュアルモノ (日本語/英語)」 */
export function audioLabel(audio: Audio): string {
    const type = AUDIO_TYPE[audio.componentType] ?? `種別${audio.componentType}`;
    const langs = (audio.langs ?? []).map((lang) => LANGUAGE[lang] ?? lang);
    return langs.length === 0 ? type : `${type} (${langs.join('/')})`;
}

const VIDEO_TYPE: Record<string, string> = {
    mpeg2: 'MPEG-2',
    'h.264': 'H.264',
    'h.265': 'H.265',
};

/** 「1080i MPEG-2」。どちらか片方しか無いこともある */
export function videoLabel(resolution: string | null, type: string | null): string {
    const parts = [resolution, type === null ? null : (VIDEO_TYPE[type] ?? type)];
    return parts.filter((part) => part !== null && part !== '').join(' ');
}
