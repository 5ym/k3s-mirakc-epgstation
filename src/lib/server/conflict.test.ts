import { describe, expect, test } from 'bun:test';
import { type Assignable, assign, contending, type Occupant, rivalsOf } from './conflict';

function res(over: Partial<Assignable> & { id: number }): Assignable {
    return {
        start_at: 0,
        end_at: 60,
        priority: 2,
        type: 'GR',
        channel: 'T16',
        ...over,
    };
}

const GR2 = new Map([
    ['GR', 2],
    ['BS', 2],
]);

describe('assign', () => {
    test('チューナー本数に収まるものは全部採用する', () => {
        const { accepted, rejected } = assign(
            [res({ id: 1, channel: 'T16' }), res({ id: 2, channel: 'T21' })],
            GR2,
        );
        expect(accepted).toHaveLength(2);
        expect(rejected).toHaveLength(0);
    });

    test('同じチャンネルならチューナーを共有するので何本でも入る', () => {
        const { rejected } = assign(
            [1, 2, 3, 4, 5].map((id) => res({ id, channel: 'T16' })),
            GR2,
        );
        expect(rejected).toHaveLength(0);
    });

    test('本数を超える異なるチャンネルは競合にする', () => {
        const { accepted, rejected } = assign(
            [res({ id: 1, channel: 'T16' }), res({ id: 2, channel: 'T21' }), res({ id: 3, channel: 'T23' })],
            GR2,
        );
        expect(accepted.map((a) => a.id).sort()).toEqual([1, 2]);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reservation.id).toBe(3);
        expect(rejected[0].reason).toContain('GR のチューナー 2 本');
    });

    test('優先度が高いものを残す', () => {
        const { accepted, rejected } = assign(
            [
                res({ id: 1, channel: 'T16', priority: 1 }),
                res({ id: 2, channel: 'T21', priority: 1 }),
                res({ id: 3, channel: 'T23', priority: 5 }),
            ],
            GR2,
        );
        expect(accepted.map((a) => a.id)).toContain(3);
        expect(rejected[0].reservation.priority).toBe(1);
    });

    test('時間が重ならなければ本数を消費しない', () => {
        const { rejected } = assign(
            [
                res({ id: 1, channel: 'T16', start_at: 0, end_at: 60 }),
                res({ id: 2, channel: 'T21', start_at: 0, end_at: 60 }),
                res({ id: 3, channel: 'T23', start_at: 60, end_at: 120 }),
            ],
            GR2,
        );
        expect(rejected).toHaveLength(0);
    });

    test('種別ごとに本数を数える (GRが埋まっていてもBSは録れる)', () => {
        const { rejected } = assign(
            [
                res({ id: 1, channel: 'T16' }),
                res({ id: 2, channel: 'T21' }),
                res({ id: 3, type: 'BS', channel: 'BS11_0' }),
            ],
            GR2,
        );
        expect(rejected).toHaveLength(0);
    });

    test('本数が分からない種別は制限しない', () => {
        const { rejected } = assign(
            [1, 2, 3, 4].map((id) => res({ id, type: 'CS', channel: `CS${id}` })),
            GR2,
        );
        expect(rejected).toHaveLength(0);
    });
});

describe('assign (前後マージン)', () => {
    const GR1 = new Map([['GR', 1]]);
    const MARGINS = { start: 10, end: 15 };

    test('隣り合う番組でもマージンぶんチューナーが重なるなら競合にする', () => {
        // 22:00 終了 → 22:00 開始。番組の時刻だけ見ると重ならないが、
        // 前は +15 まで録り続け、後は -10 から録り始めるので実際は 25 重なる
        const { accepted, rejected } = assign(
            [
                res({ id: 1, start_at: 0, end_at: 100, channel: 'T16' }),
                res({ id: 2, start_at: 100, end_at: 200, channel: 'T21' }),
            ],
            GR1,
            MARGINS,
        );
        expect(accepted.map((a) => a.id)).toEqual([1]);
        expect(rejected).toHaveLength(1);
    });

    test('同じチャンネルならマージンが重なってもチューナーは1本で足りる', () => {
        const { accepted, rejected } = assign(
            [
                res({ id: 1, start_at: 0, end_at: 100, channel: 'T16' }),
                res({ id: 2, start_at: 100, end_at: 200, channel: 'T16' }),
            ],
            GR1,
            MARGINS,
        );
        expect(accepted).toHaveLength(2);
        expect(rejected).toHaveLength(0);
    });

    test('マージンぶん離れていれば競合しない', () => {
        const { accepted } = assign(
            [
                res({ id: 1, start_at: 0, end_at: 100, channel: 'T16' }),
                res({ id: 2, start_at: 130, end_at: 200, channel: 'T21' }),
            ],
            GR1,
            MARGINS,
        );
        expect(accepted).toHaveLength(2);
    });
});

/**
 * ルール画面のプレビューが出す「チューナーの取り合い」。
 *
 * 数え方は `assign` と同じ。ここだけズレると、画面が競合と言っているのに
 * スケジューラは通す (逆もある) ことになる。
 */
function occ(over: Partial<Occupant> & { programId: number }): Occupant {
    return {
        name: `番組${over.programId}`,
        serviceName: '局',
        type: 'GR',
        channel: 'T16',
        start_at: 0,
        end_at: 60,
        ...over,
    };
}

const NO_MARGIN = { start: 0, end: 0 };

function against(row: Occupant, others: Occupant[], capacity: Map<string, number>): string[] {
    return contending(row, rivalsOf([row, ...others], NO_MARGIN), capacity, NO_MARGIN);
}

describe('チューナーの取り合い (プレビュー)', () => {
    test('種別が違えば取り合わない。衛星に地上波は出さない', () => {
        /*
         * 実機で出ていたやつ。チューナーは GR / BS・CS で別々に刺さっているのに、
         * 全部まとめて数えていたので衛星の番組に地上波の番組が並んでいた
         */
        const bs = occ({ programId: 1, type: 'BS', channel: 'BS15_0' });
        const gr = occ({ programId: 2, type: 'GR', channel: 'T16' });
        expect(against(bs, [gr], new Map([['BS', 1]]))).toEqual([]);
    });

    test('本数に収まっていれば、重なっていても出さない', () => {
        const mine = occ({ programId: 1, channel: 'T16' });
        const other = occ({ programId: 2, channel: 'T21' });
        // 地上波2本あるので、別チャンネル2番組は録れる
        expect(against(mine, [other], new Map([['GR', 2]]))).toEqual([]);
        // 1本しかなければ取り合う
        expect(against(mine, [other], new Map([['GR', 1]]))).toEqual(['番組2 (局)']);
    });

    test('同じ物理チャンネルは1本で足りるので数にも名前にも入れない', () => {
        const mine = occ({ programId: 1, channel: 'T16' });
        const sameCh = occ({ programId: 2, channel: 'T16' });
        expect(against(mine, [sameCh], new Map([['GR', 1]]))).toEqual([]);
    });

    test('足りないときは相手を全部返す', () => {
        const mine = occ({ programId: 1, channel: 'T16' });
        const a = occ({ programId: 2, channel: 'T21' });
        const b = occ({ programId: 3, channel: 'T25' });
        expect(against(mine, [a, b], new Map([['GR', 1]])).sort()).toEqual(['番組2 (局)', '番組3 (局)']);
    });

    test('互いに重なっていない相手を足し合わせない', () => {
        // 自分 0-60 / A 0-20 / B 40-60。同時に要るのは常に2チャンネルまで
        const mine = occ({ programId: 1, channel: 'T16', start_at: 0, end_at: 60 });
        const a = occ({ programId: 2, channel: 'T21', start_at: 0, end_at: 20 });
        const b = occ({ programId: 3, channel: 'T25', start_at: 40, end_at: 60 });
        expect(against(mine, [a, b], new Map([['GR', 2]]))).toEqual([]);
    });

    test('本数が分からないときは何も言わない', () => {
        const mine = occ({ programId: 1, channel: 'T16' });
        const other = occ({ programId: 2, channel: 'T21' });
        expect(against(mine, [other], new Map())).toEqual([]);
    });
});
