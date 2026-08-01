import { describe, expect, test } from 'bun:test';
import { type Assignable, assign } from './conflict';

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
