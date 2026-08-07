import { describe, expect, test } from 'bun:test';
import { EpgReader, parseBcdDuration, parseEit, parseMjdTime, ScheduleProgress } from './eit';
import { eitSection, packetize, type SynthEvent } from './synth';

const NETWORK = 32736;
const TSID = 32736;
const SERVICE = 1024;

/** 2026-08-03 12:00:00 JST */
const NOON = Date.UTC(2026, 7, 3, 3, 0, 0);
/**
 * 2026-08-03 00:10 JST。**まだどの枠も過ぎていない時刻**。
 *
 * 過ぎた時間帯のセグメントは数に入れないので、時計を止めておかないと
 * 走らせた時刻でテストの意味が変わる (昼に走らせると午前の枠が消える)
 */
const DAY_START = Date.UTC(2026, 7, 2, 15, 10, 0);

function event(overrides: Partial<SynthEvent> = {}): SynthEvent {
    return {
        eventId: 1,
        startAt: NOON,
        duration: 30 * 60 * 1000,
        name: 'テスト番組',
        description: 'これは説明です',
        ...overrides,
    };
}

function section(events: SynthEvent[], options: Record<string, number> = {}) {
    return eitSection({
        tableId: 0x50,
        serviceId: SERVICE,
        transportStreamId: TSID,
        originalNetworkId: NETWORK,
        events,
        ...options,
    });
}

describe('時刻', () => {
    test('MJD + BCD は日本時間として読む', () => {
        const data = section([event()]);
        expect(parseEit(data)?.events[0].startAt).toBe(NOON);
    });

    test('全ビット1は「未定」。番組表に置けないので null', () => {
        const data = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]);
        expect(parseMjdTime(data, 0)).toBeNull();
        expect(parseBcdDuration(data, 0)).toBeNull();
    });

    test('尺は BCD の時分秒', () => {
        // 1時間30分
        expect(parseBcdDuration(Uint8Array.from([0x01, 0x30, 0x00]), 0)).toBe(90 * 60 * 1000);
    });
});

describe('EIT の解析', () => {
    test('番組名と概要を ARIB の文字符号から起こす', () => {
        const parsed = parseEit(section([event()]));
        expect(parsed?.events).toHaveLength(1);
        expect(parsed?.events[0].name).toBe('テスト番組');
        expect(parsed?.events[0].description).toBe('これは説明です');
        expect(parsed?.events[0].duration).toBe(30 * 60 * 1000);
    });

    test('局とネットワークは番組にも写す。番組表の JOIN がこれで決まる', () => {
        const parsed = parseEit(section([event()]));
        expect(parsed?.events[0].serviceId).toBe(SERVICE);
        expect(parsed?.events[0].originalNetworkId).toBe(NETWORK);
        expect(parsed?.events[0].transportStreamId).toBe(TSID);
    });

    test('詳細情報は見出しごとに繋ぎ直す', () => {
        const parsed = parseEit(
            section([event({ extended: { 出演者: 'ゲスト太郎', 番組内容: 'あらすじ' } })]),
        );
        expect(parsed?.events[0].extended).toEqual({ 出演者: 'ゲスト太郎', 番組内容: 'あらすじ' });
    });

    test('ジャンル・音声・映像', () => {
        const parsed = parseEit(
            section([event({ genres: [[7, 0]], audios: [{ type: 3 }], video: [0x01, 0xb1] })]),
        );
        const found = parsed?.events[0];
        expect(found?.genres).toEqual([{ lv1: 7, lv2: 0 }]);
        expect(found?.audios).toEqual([
            { componentType: 3, langs: ['jpn'], samplingRate: 48000, main: true },
        ]);
        expect(found?.video).toEqual({ type: 'mpeg2', resolution: '1080i' });
    });

    /*
     * **放送が付けた名前まで読む。**
     *
     * 解説放送や二重音声は、種別も言語も同じ音声が2本並ぶ。実機の日テレ
     * 「金曜ロードショー[解]」はどちらも `component_type=3 lang=jpn` で、
     * 見分けが付くのは `text_char` の「主音声ステレオ」「解説ステレオ」だけ。
     * 読み落としていた頃は、番組表の詳細に**同じ札が2つ**出ていた
     */
    test('音声が名乗っている名前と、どちらが主音声か', () => {
        const parsed = parseEit(
            section([
                event({
                    audios: [
                        { type: 3, text: '主音声ステレオ' },
                        { type: 3, text: '解説ステレオ', main: false },
                    ],
                }),
            ]),
        );
        expect(parsed?.events[0]?.audios).toEqual([
            { componentType: 3, langs: ['jpn'], samplingRate: 48000, text: '主音声ステレオ', main: true },
            { componentType: 3, langs: ['jpn'], samplingRate: 48000, text: '解説ステレオ', main: false },
        ]);
    });

    /** 名乗らない放送のほうが多い。**空の名前は持たない** (札に空白が出る) */
    test('名乗らなければ名前は持たない', () => {
        const parsed = parseEit(section([event({ audios: [{ type: 3 }] })]));
        expect(parsed?.events[0]?.audios[0]).not.toHaveProperty('text');
    });

    test('有料放送は free_CA_mode で分かる', () => {
        expect(parseEit(section([event()]))?.events[0].isFree).toBe(true);
        expect(parseEit(section([event({ isFree: false })]))?.events[0].isFree).toBe(false);
    });

    test('他局の番組表 (0x4F / 0x60〜) は読まない', () => {
        expect(parseEit(section([event()], { tableId: 0x4f }))).toBeNull();
        expect(parseEit(section([event()], { tableId: 0x60 }))).toBeNull();
    });

    test('1セクションに複数の番組が並ぶ', () => {
        const events = [
            event({ eventId: 1 }),
            event({ eventId: 2, startAt: NOON + 1800_000, name: '次の番組' }),
        ];
        const parsed = parseEit(section(events));
        expect(parsed?.events.map((e) => e.name)).toEqual(['テスト番組', '次の番組']);
    });
});

describe('集まり具合', () => {
    const progressAt = (now: number = DAY_START) => new ScheduleProgress(() => now);

    /** セクション1本ぶんの控えを組み立てる */
    const at = (tableId: number, sectionNumber: number, last: number, segmentLast = last) => ({
        tableId,
        serviceId: SERVICE,
        transportStreamId: TSID,
        originalNetworkId: NETWORK,
        version: 1,
        sectionNumber,
        lastSectionNumber: last,
        segmentLastSectionNumber: segmentLast,
        lastTableId: tableId,
        events: [],
    });

    test('使われているセクションが全部揃えば完了', () => {
        const progress = progressAt();
        expect(progress.complete).toBe(false);
        progress.add(at(0x50, 0, 1, 1));
        expect(progress.complete).toBe(false);
        progress.add(at(0x50, 1, 1, 1));
        expect(progress.complete).toBe(true);
    });

    /**
     * **使われていないセクションは永久に来ない。** セグメントの最後の番号を
     * 見ずに「0〜last_section_number が全部」で待つと、いつまでも終わらない
     */
    test('セグメントの中で使われていない番号は待たない', () => {
        const progress = progressAt();
        // 2つのセグメント。どちらも先頭1本しか使っていない
        progress.add(at(0x50, 0, 8, 0));
        progress.add(at(0x50, 8, 8, 8));
        expect(progress.complete).toBe(true);
    });

    test('last_table_id の先まで揃うまでは完了にしない', () => {
        const progress = progressAt();
        progress.add({ ...at(0x50, 0, 0), lastTableId: 0x51 });
        expect(progress.complete).toBe(false);
        progress.add({ ...at(0x51, 0, 0), lastTableId: 0x51 });
        expect(progress.complete).toBe(true);
    });

    /*
     * **番号は飛ぶ。** 1つの table_id が受け持つのは4日ぶんで、基本は 0x50 から、
     * 詳細は 0x58 から始まる。8日ぶんの放送なら 0x52〜0x57 は永久に来ない。
     * 0x50 から last_table_id まで全部待っていた頃は、詳細を積んでいる局が
     * **一度も揃わず**、5分の上限まで開きっぱなしになっていた
     */
    test('間の使われていない表は待たない', () => {
        const progress = progressAt();
        progress.add({ ...at(0x50, 0, 0), lastTableId: 0x59 });
        progress.add({ ...at(0x51, 0, 0), lastTableId: 0x59 });
        progress.add({ ...at(0x58, 0, 0), lastTableId: 0x59 });
        // 0x52〜0x57 は来ないが、いちばん後ろの 0x59 はまだ
        expect(progress.complete).toBe(false);
        progress.add({ ...at(0x59, 0, 0), lastTableId: 0x59 });
        expect(progress.complete).toBe(true);
    });

    test('版が変わったら数え直す。古い版で揃ったことにしない', () => {
        const progress = progressAt();
        progress.add(at(0x50, 0, 0));
        expect(progress.complete).toBe(true);
        progress.add({ ...at(0x50, 0, 1, 1), version: 2 });
        expect(progress.complete).toBe(false);
    });

    /*
     * **版は table_id ごとに別々に振られる。** 番組表の1つの表は
     * table_id + 局 + TS で決まり、`version_number` はその単位で動く。
     * 局に1つだけ持っていた頃は、基本 (0x50〜) と詳細 (0x58〜) を行き来する
     * たびに数えたものを全部捨てていて、**揃ったと分かることが二度と無かった**。
     * どのチャンネルも1本5分の上限まで開きっぱなしになる
     */
    test('別の表の版が違っても、こちらの数えたものは捨てない', () => {
        const progress = progressAt();
        progress.add({ ...at(0x50, 0, 0), lastTableId: 0x58 });
        // 詳細の表は別の版で流れてくる。ここで基本のぶんを捨ててはいけない
        progress.add({ ...at(0x58, 0, 0), lastTableId: 0x58, version: 9 });

        // 0x51〜0x57 は使われていないので、この2つで揃っている
        expect(progress.complete).toBe(true);
    });

    test('同じ表の版が変わったときだけ、その表を数え直す', () => {
        const progress = progressAt();
        progress.add({ ...at(0x50, 0, 0), lastTableId: 0x58 });
        progress.add({ ...at(0x58, 0, 0), lastTableId: 0x58, version: 9 });
        expect(progress.complete).toBe(true);

        // 詳細だけ版が上がった。基本はそのまま、詳細だけ待ち直す
        progress.add({ ...at(0x58, 0, 1, 1), lastTableId: 0x58, version: 10 });
        expect(progress.complete).toBe(false);
        progress.add({ ...at(0x58, 1, 1, 1), lastTableId: 0x58, version: 10 });
        expect(progress.complete).toBe(true);
    });

    /*
     * **揃わなかったときは、何が足りないかを言う。**
     *
     * 実測でチューナーを1本 600秒 (上限ちょうど) 掴んでいるのを見つけたが、
     * 電波が欠けていたのか、来ない表を待っていたのかは記録が無くて追えなかった。
     * 直し方がまるで違うので、区別が付く形で残す
     */
    test('揃わなかった理由を言える', () => {
        const empty = progressAt();
        expect(empty.report()).toContain('1つも来ていない');

        // いちばん後ろの表が来ない (来ない表を待っている状態)
        const waiting = progressAt();
        waiting.add({ ...at(0x50, 0, 0), lastTableId: 0x59 });
        expect(waiting.report()).toContain('0x59');
        expect(waiting.report()).toContain('一度も来ない');

        // 節が欠けている (電波が届いていない状態)
        const holes = progressAt();
        holes.add(at(0x50, 0, 3, 3));
        holes.add(at(0x50, 2, 3, 3));
        expect(holes.report()).toContain('0x50 の 1,3');

        const done = progressAt();
        done.add(at(0x50, 0, 0));
        expect(done.report()).toBe('揃っている');
    });

    /*
     * **過ぎた時間帯のセグメントは流れてこない。**
     *
     * セグメントは 0:00 から3時間ずつの枠で、終わった枠は放送に乗らない。
     * 「空でも先頭の1本 (8の倍数) は来る」として待っていた頃は、**実機の
     * 14チャンネルが1つ残らず上限の600秒を使い切って**いた — 揃って離せたのは
     * 0本で、早く離す仕組みがまるごと働いていなかった。
     *
     * 実機の記録がそのまま出方を教えてくれた。16:59 に閉じた回はどの局も
     * `0x50/0x58 の 0,8,16,24,32` (= 0:00〜15:00 の5枠)、18:19 に閉じた回は
     * そこに `40` が増えていた。**時計が進むと欠けが1つ増える** — 電波の
     * 欠けでは起きない動き方で、待ち方のほうが誤っていると分かる。
     *
     * 過ぎた枠のぶんの番組は、そこがまだ未来だった数日前に取り込んである。
     */
    test('もう過ぎた時間帯のセグメントは待たない', () => {
        // 15:30 JST。0:00〜15:00 の5枠 (節 0,8,16,24,32) は終わっている
        const afternoon = Date.UTC(2026, 7, 3, 6, 30, 0);
        const progress = progressAt(afternoon);

        // いま (15:00〜18:00) の枠から先だけが流れてくる
        for (let start = 40; start <= 248; start += 8) progress.add(at(0x50, start, 255, start));
        expect(progress.complete).toBe(true);
        expect(progress.report()).toBe('揃っている');

        // 過ぎていない枠が欠けているのは、これまで通り「足りない」
        const missing = progressAt(afternoon);
        for (let start = 40; start <= 248; start += 8) {
            if (start !== 48) missing.add(at(0x50, start, 255, start));
        }
        expect(missing.complete).toBe(false);
        expect(missing.report()).toContain('0x50 の 48');
    });

    /*
     * 枠の位置は `table_id` でずれる。0x50 が当日 0:00 から4日ぶん (32枠) で、
     * 0x51 はその次の4日ぶん。**先の表には過ぎた枠が1つも無い。**
     *
     * 「見えていない先頭は飛ばす」という時計を使わない直し方も採れたが、
     * それだとカルーセルの途中から拾い始めた回に、まだ来ていないだけの先頭を
     * 飛ばして 0x51 を揃ったことにしてしまう (4〜7日先が丸ごと落ちる)
     */
    test('先の日を持つ表では、どの枠も飛ばさない', () => {
        const afternoon = Date.UTC(2026, 7, 3, 6, 30, 0);
        const progress = progressAt(afternoon);
        progress.add({ ...at(0x50, 40, 40), lastTableId: 0x51 });
        // 0x51 は4日先から。先頭の枠もまだ過ぎていない
        progress.add({ ...at(0x51, 8, 8), lastTableId: 0x51 });
        expect(progress.complete).toBe(false);
        expect(progress.report()).toContain('0x51 の 0');
    });
});

describe('EpgReader', () => {
    const packets = (data: Uint8Array) => packetize(0x0012, data);

    test('TS を食わせると番組が溜まる', () => {
        const reader = new EpgReader();
        expect(reader.feed(packets(section([event()])))).toBe(true);
        expect(reader.all().map((e) => e.name)).toEqual(['テスト番組']);
    });

    test('同じ番組が何度来ても増えない。あとから来たほうで上書きする', () => {
        const reader = new EpgReader();
        reader.feed(packets(section([event()])));
        reader.feed(packets(section([event({ name: '差し替え後' })])));
        expect(reader.all()).toHaveLength(1);
        expect(reader.all()[0].name).toBe('差し替え後');
    });

    /*
     * **実機で踏んだところ。** 番組表は2つの表に分かれて流れてくる。
     *
     * - 基本 (0x50〜0x57) … 題名と短い説明
     * - 詳細 (0x58〜0x5F) … 「番組内容」「出演者」など
     *
     * 同じ event_id が両方に載っていて、それぞれ自分のぶんしか持っていない。
     * 丸ごと上書きしていた頃は、あとに届いたほうで相手のぶんが消えていた。
     * 実機では番組 23,000 件のうち 11,000 件が名無しになり、番組表に
     * 「(番組情報なし)」の列が並んだ
     */
    test('詳細だけの表があとから来ても題名を消さない', () => {
        const reader = new EpgReader();
        reader.feed(packets(section([event()])));
        reader.feed(
            packets(
                section([event({ name: '', description: '', extended: { 番組内容: 'あらすじ' } })], {
                    tableId: 0x58,
                }),
            ),
        );

        const [program] = reader.all();
        expect(program.name).toBe('テスト番組');
        expect(program.description).toBe('これは説明です');
        expect(program.extended).toEqual({ 番組内容: 'あらすじ' });
    });

    test('基本の表があとから来ても番組内容を消さない', () => {
        const reader = new EpgReader();
        reader.feed(
            packets(
                section([event({ name: '', description: '', extended: { 番組内容: 'あらすじ' } })], {
                    tableId: 0x58,
                }),
            ),
        );
        reader.feed(packets(section([event()])));

        const [program] = reader.all();
        expect(program.name).toBe('テスト番組');
        expect(program.extended).toEqual({ 番組内容: 'あらすじ' });
    });

    test('開始時刻や尺が未定の番組は溜めない。録画の時刻が決まらない', () => {
        const reader = new EpgReader();
        // 尺だけ未定にする (BCD の全ビット1)
        const data = section([event()]);
        data[14 + 7] = 0xff;
        data[14 + 8] = 0xff;
        data[14 + 9] = 0xff;
        reader.feed(packets(data));
        expect(reader.all()).toHaveLength(0);
    });

    /**
     * 1本の物理チャンネルには複数の局が乗っている (地上波なら MX1 と MX2)。
     * 先に揃ったほうで閉じると、残りが永久に埋まらない
     */
    test('乗っている局が全部揃うまで完了にしない', () => {
        // 揃ったかどうかを見るので、枠が過ぎていない時刻で止めておく
        const reader = new EpgReader(() => DAY_START);
        reader.feed(packets(section([event()])));
        expect(reader.complete).toBe(true);
        reader.feed(packets(section([event()], { serviceId: SERVICE + 1, lastSectionNumber: 1 })));
        expect(reader.complete).toBe(false);
        expect(reader.services()).toEqual([SERVICE, SERVICE + 1]);
    });

    test('EIT[p/f] の「放送中」は別に持つ。録画の延長追従に使う', () => {
        const reader = new EpgReader();
        const pf = section([event({ runningStatus: 4, name: 'いま放送中' })], { tableId: 0x4e });
        reader.feed(packets(pf));
        expect(reader.present.get(SERVICE)?.name).toBe('いま放送中');
        // p/f だけでは番組表が揃ったことにはならない
        expect(reader.complete).toBe(false);
    });

    /*
     * **実機で踏んだところ。** running_status を 4 にしてくれない局がある
     * (NHK は 74 節ぜんぶ 0 だった)。4 だけを見ていると、そういう局では
     * 延長追従が丸ごと効かない。p/f は仕様で section 0 が現在なので、
     * 0 (未定義) のときはそちらで決める (docs/agent.md)
     */
    test('running_status を入れてこない局でも「放送中」が分かる', () => {
        const reader = new EpgReader();
        reader.feed(
            packets(
                section([event({ runningStatus: 0, name: 'いま放送中' })], {
                    tableId: 0x4e,
                    sectionNumber: 0,
                    lastSectionNumber: 1,
                }),
            ),
        );
        expect(reader.present.get(SERVICE)?.name).toBe('いま放送中');
    });

    test('次の番組は「放送中」にしない', () => {
        const reader = new EpgReader();
        reader.feed(
            packets(
                section([event({ runningStatus: 0, name: 'つぎの番組' })], {
                    tableId: 0x4e,
                    sectionNumber: 1,
                    lastSectionNumber: 1,
                }),
            ),
        );
        expect(reader.present.has(SERVICE)).toBe(false);
    });
});
