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

/**
 * ルールの条件の値を人が読める名前に。`"7-0"` → 「アニメ／特撮 > 国内アニメ」。
 *
 * 中分類が無いときは大分類だけを返す。**「7」のように - が無い値では
 * split の2つ目が undefined になる** ので、`Number.isNaN` では捕まらない
 * (`Number.isNaN(undefined)` は false)。これを見落として
 * 「アニメ／特撮 > undefined」と出していた。要素数で見る。
 */
export function genreName(value: string | number): string {
    const parts = String(value).split('-');
    const lv1 = Number(parts[0]);
    const head = GENRE_LV1[lv1];
    if (head === undefined) return String(value);
    if (parts.length < 2) return head;

    const lv2 = Number(parts[1]);
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
    /**
     * 放送が自分で付けた名前 (`audio_component_descriptor` の `text_char`)。
     * 「主音声ステレオ」「解説ステレオ」
     */
    text?: string;
    /** 主音声か。**解説放送はこちらが立っていないほう** */
    main?: boolean;
}

/**
 * 「主音声ステレオ (日本語)」「ステレオ (日本語)」「デュアルモノ (日本語/英語)」
 *
 * **放送が名乗っていれば、その名前を使う。**
 *
 * 符号 (`component_type` と言語) からだけでは、同じ構成の音声が2本ある番組を
 * 区別できない — 実機の日テレ「金曜ロードショー[解]」では、主音声も解説も
 * `component_type=3 lang=jpn` なので、**「ステレオ (日本語)」が2つ並んでいた**。
 * 放送のほうは `text_char` に「主音声ステレオ」「解説ステレオ」と書いている。
 *
 * その名前には構成 (「ステレオ」) まで入っていることが多いので、こちらの
 * 対応表と繋げず**差し替える**。言語は名前に入っていないので添える
 */
export function audioLabel(audio: Audio): string {
    const type =
        audio.text !== undefined && audio.text !== ''
            ? audio.text
            : (AUDIO_TYPE[audio.componentType] ?? `種別${audio.componentType}`);
    const langs = (audio.langs ?? []).map((lang) => LANGUAGE[lang] ?? lang);
    return langs.length === 0 ? type : `${type} (${langs.join('/')})`;
}

/**
 * 番組表の `audio_type` が言う「二カ国語」。**左右に別の言語が乗っている**
 * (ARIB STD-B32)。録画もライブも、見分け方はここ1つ
 */
export const DUAL_MONO = 2;

/**
 * どちらの音を出すか。
 *
 * `both` は入っているものをそのまま出す。デュアルモノで `both` を選ぶと
 * 左右から別の言語が同時に鳴る — テレビの「主+副」と同じ状態
 */
export type AudioSide = 'main' | 'sub' | 'both';

/** 選べる音声1つぶん */
export interface AudioTrack {
    /** 選ぶときの合言葉。`"0:main"` の形。**画面とサーバの間で渡す** */
    id: string;
    /** 何本目の音声か。ffmpeg の `-map 0:a:<これ>` に渡す */
    stream: number;
    side: AudioSide;
    /** 「主音声 (日本語)」「音声2 ステレオ (英語)」 */
    label: string;
    /** 放送が「主音声」と言っているか。**何も頼まれなかったときに選ぶ** */
    main?: boolean;
}

/**
 * 番組表の音声情報から、**選べるものを並べる。**
 *
 * 日本の放送で「多重音声」と呼ばれるものは2通りあり、見た目は同じでも中身が違う。
 *
 * - **デュアルモノ** … 音声は1本で、左に主音声・右に副音声が入っている
 *   (二カ国語、解説放送)。分けるには左右のどちらかを両耳へ配り直す
 * - **複数の音声** … 音声そのものが2本以上入っている。分けるにはどちらを
 *   取り出すかを選ぶ
 *
 * どちらも「音声を選ぶ」1つの操作に見せたいので、**両方を平らに並べて**
 * 1つの一覧にする。デュアルモノは1本から3つ (主・副・主+副) 出てくる。
 *
 * **番組表が何も言っていなければ1つだけ返す。** 音声が無いことはないので、
 * 何も出せないより「そのまま出す」1つを置くほうが確か
 */
export function audioTracks(audios: Audio[]): AudioTrack[] {
    // 音声が2本以上あるときだけ「音声1/音声2」を添える。1本のときは邪魔なだけ
    const many = audios.length > 1;
    const tracks: AudioTrack[] = [];

    audios.forEach((audio, stream) => {
        /*
         * **放送が名乗っていれば、何本目かは添えない。**
         *
         * 「主音声ステレオ」「解説ステレオ」と名前が付いているところへ
         * 「音声1」「音声2」まで足すと、長いだけで何も増えない。名前が
         * 無いときだけ、番号で呼ぶしかない
         */
        const named = audio.text !== undefined && audio.text !== '';
        const head = many && !named ? `音声${stream + 1} ` : '';
        const langs = (audio.langs ?? []).map((lang) => LANGUAGE[lang] ?? lang);
        const of = (index: number) => (langs[index] === undefined ? '' : ` (${langs[index]})`);
        const main = audio.main;

        if (audio.componentType === DUAL_MONO) {
            // 左右に分かれているので、名前ではなくどちら側かで呼ぶ
            const index = many ? `音声${stream + 1} ` : '';
            tracks.push(
                { id: `${stream}:main`, stream, side: 'main', label: `${index}主音声${of(0)}`, main },
                { id: `${stream}:sub`, stream, side: 'sub', label: `${index}副音声${of(1)}`, main },
                { id: `${stream}:both`, stream, side: 'both', label: `${index}主+副`, main },
            );
        } else {
            tracks.push({
                id: `${stream}:both`,
                stream,
                side: 'both',
                label: `${head}${audioLabel(audio)}`,
                main,
            });
        }
    });

    if (tracks.length === 0) return [{ id: '0:both', stream: 0, side: 'both', label: '音声' }];
    return tracks;
}

/**
 * 頼まれたものを選ぶ。**知らないものを頼まれたら主音声。**
 *
 * 番組が変われば音声の構成も変わる (二カ国語の映画が終わればステレオに戻る)。
 * 前の番組の合言葉が残っていても、無いものは選べない。
 *
 * **どれが主音声かは放送が言っている** (`main_component_flag`)。並び順の1本目が
 * 主音声とは限らないので、言っているならそちらに従う。何も言っていなければ先頭
 */
export function pickTrack(tracks: AudioTrack[], wanted: string | undefined): AudioTrack {
    return tracks.find((track) => track.id === wanted) ?? tracks.find((track) => track.main) ?? tracks[0];
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
