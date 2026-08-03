import { describe, expect, test } from 'bun:test';
import { EpgReader, parseBcdDuration, parseEit, parseMjdTime, ScheduleProgress } from './eit';
import { eitSection, packetize, type SynthEvent } from './synth';

const NETWORK = 32736;
const TSID = 32736;
const SERVICE = 1024;

/** 2026-08-03 12:00:00 JST */
const NOON = Date.UTC(2026, 7, 3, 3, 0, 0);

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
        const parsed = parseEit(section([event({ genres: [[7, 0]], audioType: 3, video: [0x01, 0xb1] })]));
        const found = parsed?.events[0];
        expect(found?.genres).toEqual([{ lv1: 7, lv2: 0 }]);
        expect(found?.audios).toEqual([{ componentType: 3, langs: ['jpn'], samplingRate: 48000 }]);
        expect(found?.video).toEqual({ type: 'mpeg2', resolution: '1080i' });
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
        const progress = new ScheduleProgress();
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
        const progress = new ScheduleProgress();
        // 2つのセグメント。どちらも先頭1本しか使っていない
        progress.add(at(0x50, 0, 8, 0));
        progress.add(at(0x50, 8, 8, 8));
        expect(progress.complete).toBe(true);
    });

    test('last_table_id の先まで揃うまでは完了にしない', () => {
        const progress = new ScheduleProgress();
        progress.add({ ...at(0x50, 0, 0), lastTableId: 0x51 });
        expect(progress.complete).toBe(false);
        progress.add({ ...at(0x51, 0, 0), lastTableId: 0x51 });
        expect(progress.complete).toBe(true);
    });

    test('版が変わったら数え直す。古い版で揃ったことにしない', () => {
        const progress = new ScheduleProgress();
        progress.add(at(0x50, 0, 0));
        expect(progress.complete).toBe(true);
        progress.add({ ...at(0x50, 0, 1, 1), version: 2 });
        expect(progress.complete).toBe(false);
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
        const reader = new EpgReader();
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
});
