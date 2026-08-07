import { describe, expect, test } from 'bun:test';
import { audioLabel, audioTracks, genreLabel, genreName, pickTrack, videoLabel } from './arib';

/**
 * ルールの条件に出す名前。
 *
 * 大分類だけの条件 (「アニメ全部」) は - を含まないので、split の2つ目が
 * undefined になる。`Number.isNaN(undefined)` は false なので素通りしてしまい、
 * 「アニメ／特撮 > undefined」と出ていた。
 */
describe('genreName', () => {
    test('大分類だけの条件は大分類だけ出す', () => {
        expect(genreName('7')).toBe('アニメ／特撮');
        // 引き継いだルールは数値で入っている
        expect(genreName(7)).toBe('アニメ／特撮');
        expect(genreName(0)).toBe('ニュース／報道');
    });

    test('中分類まであれば繋ぐ', () => {
        expect(genreName('7-0')).toBe('アニメ／特撮 > 国内アニメ');
    });

    test('引けない値はそのまま出す', () => {
        // 12・13 は放送に出てこない予備。表に無くても値だけは見せる
        expect(genreName(12)).toBe('12');
        expect(genreName('7-99')).toBe('アニメ／特撮 > 99');
        expect(genreName('7-x')).toBe('アニメ／特撮');
    });
});

describe('genreLabel', () => {
    test('大分類と中分類をつなげる', () => {
        expect(genreLabel({ lv1: 7, lv2: 0 })).toBe('アニメ／特撮 > 国内アニメ');
        expect(genreLabel({ lv1: 0, lv2: 1 })).toBe('ニュース／報道 > 天気');
    });

    test('中分類が引けなければ大分類だけ出す', () => {
        // CS では un1/un2 に独自の値が入り、中分類が表に無いことがある
        expect(genreLabel({ lv1: 3, lv2: 9 })).toBe('ドラマ');
    });

    test('未定義の大分類は出さない', () => {
        // 0xC/0xD は予備。名前を作って出すと嘘になる
        expect(genreLabel({ lv1: 0xc, lv2: 0 })).toBe('');
    });
});

describe('audioLabel', () => {
    test('構成と言語を並べる', () => {
        expect(audioLabel({ componentType: 3, langs: ['jpn'] })).toBe('ステレオ (日本語)');
        expect(audioLabel({ componentType: 2, langs: ['jpn', 'eng'] })).toBe('デュアルモノ (日本語/英語)');
        expect(audioLabel({ componentType: 9, langs: ['jpn'] })).toBe('5.1ch (日本語)');
    });

    test('言語が無ければ構成だけ', () => {
        expect(audioLabel({ componentType: 1 })).toBe('モノラル');
    });

    test('知らない種別は番号のまま残す', () => {
        expect(audioLabel({ componentType: 99, langs: ['xyz'] })).toBe('種別99 (xyz)');
    });

    /*
     * **放送が名乗っていれば、その名前を使う。**
     *
     * 解説放送や二重音声は、種別も言語も同じ音声が2本並ぶ。実機の日テレ
     * 「金曜ロードショー[解]」はどちらも `component_type=3 lang=jpn` なので、
     * 番組表の詳細に**「ステレオ (日本語)」が2つ**出ていて見分けが付かなかった。
     * 放送のほうは `text_char` に「主音声ステレオ」「解説ステレオ」と書いている
     */
    test('放送が付けた名前があれば、そちらを出す', () => {
        expect(audioLabel({ componentType: 3, langs: ['jpn'], text: '主音声ステレオ' })).toBe(
            '主音声ステレオ (日本語)',
        );
        expect(audioLabel({ componentType: 3, langs: ['jpn'], text: '解説ステレオ' })).toBe(
            '解説ステレオ (日本語)',
        );
    });

    /** 名前に構成まで入っているので、こちらの対応表と繋げると二重になる */
    test('名前と構成を繋げない', () => {
        expect(audioLabel({ componentType: 3, langs: ['jpn'], text: '解説ステレオ' })).not.toContain(
            'ステレオステレオ',
        );
    });

    test('名前が空なら構成で呼ぶ', () => {
        expect(audioLabel({ componentType: 3, langs: ['jpn'], text: '' })).toBe('ステレオ (日本語)');
    });
});

/**
 * ライブ視聴の音声切り替えが読む一覧。
 *
 * 「多重音声」と呼ばれるものは**中身の違う2通り**が同じ名前で呼ばれている。
 * 見ている人にとってはどちらも「音声を選ぶ」1つの操作なので、平らに並べる。
 */
describe('audioTracks', () => {
    /** 普通のステレオ。選ぶものが無いので1つだけ = 画面は切り替えを出さない */
    test('1本のステレオは1つだけ', () => {
        const tracks = audioTracks([{ componentType: 3, langs: ['jpn'] }]);
        expect(tracks).toHaveLength(1);
        expect(tracks[0]).toMatchObject({ stream: 0, side: 'both', label: 'ステレオ (日本語)' });
    });

    /*
     * **デュアルモノは1本から3つ出る。** 音声は1本しか無く、左に主音声・右に
     * 副音声が入っている。テレビの「音声切換」と同じ3択に見せる
     */
    test('デュアルモノは主・副・主+副の3つ', () => {
        const tracks = audioTracks([{ componentType: 2, langs: ['jpn', 'eng'] }]);
        expect(tracks.map((track) => track.label)).toEqual(['主音声 (日本語)', '副音声 (英語)', '主+副']);
        // どれも同じ1本を指す。分けるのは左右の配り直し
        expect(tracks.every((track) => track.stream === 0)).toBe(true);
        expect(tracks.map((track) => track.side)).toEqual(['main', 'sub', 'both']);
    });

    /** 言語が1つしか載っていないことはある。**それでも主/副は選ばせる** */
    test('言語が足りなくても主副は出す', () => {
        const tracks = audioTracks([{ componentType: 2, langs: ['jpn'] }]);
        expect(tracks.map((track) => track.label)).toEqual(['主音声 (日本語)', '副音声', '主+副']);
    });

    /** 音声そのものが2本以上。解説放送など。何本目かを添えないと見分けられない */
    test('音声が2本あれば番号を添える', () => {
        const tracks = audioTracks([
            { componentType: 3, langs: ['jpn'] },
            { componentType: 3, langs: ['eng'] },
        ]);
        expect(tracks.map((track) => track.label)).toEqual([
            '音声1 ステレオ (日本語)',
            '音声2 ステレオ (英語)',
        ]);
        expect(tracks.map((track) => track.stream)).toEqual([0, 1]);
    });

    /*
     * **名乗っているなら番号は要らない。** 「主音声ステレオ」「解説ステレオ」と
     * 書いてあるところへ「音声1」「音声2」まで足すと、長いだけで何も増えない
     */
    test('放送が名乗っていれば番号は添えない', () => {
        const tracks = audioTracks([
            { componentType: 3, langs: ['jpn'], text: '主音声ステレオ', main: true },
            { componentType: 3, langs: ['jpn'], text: '解説ステレオ', main: false },
        ]);
        expect(tracks.map((track) => track.label)).toEqual([
            '主音声ステレオ (日本語)',
            '解説ステレオ (日本語)',
        ]);
    });

    /** 2本目がデュアルモノということもある。**どちらの数え方も同時に効く** */
    test('2本目がデュアルモノでも展開する', () => {
        const tracks = audioTracks([
            { componentType: 3, langs: ['jpn'] },
            { componentType: 2, langs: ['jpn', 'eng'] },
        ]);
        expect(tracks).toHaveLength(4);
        expect(tracks.slice(1).every((track) => track.stream === 1)).toBe(true);
        expect(tracks[1].label).toBe('音声2 主音声 (日本語)');
    });

    /*
     * **番組表が何も言っていなくても1つ返す。** 音声が無い放送は無いので、
     * 何も出せないより「そのまま出す」1つを置くほうが確か
     */
    test('何も分からなければそのまま出す1つ', () => {
        expect(audioTracks([])).toEqual([{ id: '0:both', stream: 0, side: 'both', label: '音声' }]);
    });
});

/**
 * **番組が変われば音声の構成も変わる。** 二カ国語の映画が終わればステレオに
 * 戻るので、覚えていた合言葉が選べなくなる。無いものを頼まれたら先頭に落とす —
 * 落とさないと、番組が変わった瞬間に音が出なくなる
 */
describe('pickTrack', () => {
    const tracks = audioTracks([{ componentType: 2, langs: ['jpn', 'eng'] }]);

    test('頼まれたものを選ぶ', () => {
        expect(pickTrack(tracks, '0:sub').side).toBe('sub');
    });

    test('無いものを頼まれたら先頭', () => {
        expect(pickTrack(tracks, '1:sub').id).toBe('0:main');
        expect(pickTrack(tracks, undefined).id).toBe('0:main');
    });

    /*
     * **どれが主音声かは放送が言っている** (`main_component_flag`)。
     * 並び順の1本目が主音声とは限らないので、言っているならそちらに従う
     */
    test('何も頼まれなければ、放送が言う主音声', () => {
        const two = audioTracks([
            { componentType: 3, langs: ['jpn'], text: '解説ステレオ', main: false },
            { componentType: 3, langs: ['jpn'], text: '主音声ステレオ', main: true },
        ]);
        expect(pickTrack(two, undefined).label).toBe('主音声ステレオ (日本語)');
    });
});

describe('videoLabel', () => {
    test('解像度と符号化方式を並べる', () => {
        expect(videoLabel('1080i', 'mpeg2')).toBe('1080i MPEG-2');
        expect(videoLabel('480i', 'h.264')).toBe('480i H.264');
    });

    test('片方しか無ければあるほうだけ', () => {
        expect(videoLabel('1080i', null)).toBe('1080i');
        expect(videoLabel(null, 'mpeg2')).toBe('MPEG-2');
        expect(videoLabel(null, null)).toBe('');
    });
});
