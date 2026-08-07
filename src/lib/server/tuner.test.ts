import { describe, expect, test } from 'bun:test';
import { retryWhileBusy, TunerBusyError } from './tuner';

/**
 * **空きが無いだけなら、掛け直せば通る。**
 *
 * ライブはチャンネルを変える一瞬だけ、前のチャンネルと合わせてチューナーが
 * 2本要る — 前のを離してから頼んでいるが、離れたことがエージェントに届くのは
 * 非同期なので重なる瞬間が残る。地上波は2本しかないので、録画か番組表集めが
 * 1本使っていると、そこで断られていた (実機で
 * `[live] GR:T15: チューナーに空きがありません`)。
 *
 * 字幕側で一度断られると、**そのチャンネルの字幕がそれきり出ない**という
 * 出方をしていた。見ている側は局を選び直すまで戻せない。
 *
 * **待つところは差し替える。** 本当に待たせるとテストがそのぶん延びるだけで、
 * 確かめたいのは「何回掛け直すか」のほう
 */
describe('retryWhileBusy', () => {
    /** 待った回数を数えるだけの、待たない待ち */
    const clock = () => {
        const waits: number[] = [];
        return { waits, wait: async (ms: number) => void waits.push(ms) };
    };

    test('空き待ちなら掛け直して通る', async () => {
        const { waits, wait } = clock();
        let asked = 0;
        const got = await retryWhileBusy(
            () => {
                asked++;
                if (asked === 1) throw new TunerBusyError('空きがありません');
                return Promise.resolve('とれた');
            },
            () => false,
            wait,
        );
        expect(got).toBe('とれた');
        expect(asked).toBe(2);
        expect(waits).toHaveLength(1);
    });

    /** 選局そのものが駄目なら、何度やっても同じ。待たせるだけ無駄 */
    test('空き待ち以外は掛け直さない', async () => {
        const { waits, wait } = clock();
        let asked = 0;
        await expect(
            retryWhileBusy(
                () => {
                    asked++;
                    return Promise.reject(new Error('選局できません (500)'));
                },
                () => false,
                wait,
            ),
        ).rejects.toThrow(/選局できません/);
        expect(asked).toBe(1);
        expect(waits).toHaveLength(0);
    });

    /** 畳まれたなら待たない。見ている人はもう別の局へ行っている */
    test('畳まれたら待たずに諦める', async () => {
        const { waits, wait } = clock();
        let asked = 0;
        await expect(
            retryWhileBusy(
                () => {
                    asked++;
                    return Promise.reject(new TunerBusyError('空きがありません'));
                },
                () => true,
                wait,
            ),
        ).rejects.toThrow(/空きがありません/);
        expect(asked).toBe(1);
        expect(waits).toHaveLength(0);
    });

    /** 待っても空かないなら、いつかは諦める。無限には掛け直さない */
    test('いつかは諦める', async () => {
        const { waits, wait } = clock();
        let asked = 0;
        await expect(
            retryWhileBusy(
                () => {
                    asked++;
                    return Promise.reject(new TunerBusyError('空きがありません'));
                },
                () => false,
                wait,
            ),
        ).rejects.toThrow(/空きがありません/);
        expect(asked).toBeGreaterThan(1);
        expect(asked).toBeLessThanOrEqual(5);
        expect(waits.every((ms) => ms > 0)).toBe(true);
    });
});
