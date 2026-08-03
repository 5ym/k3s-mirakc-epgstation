import { afterEach, describe, expect, test } from 'bun:test';
import { takeOverSignals } from './runtime';

/**
 * 止まれの合図を誰が受けるか。
 *
 * adapter-node は SIGTERM を受けたその場で listen を閉じる。録画が終わるまで
 * 居座る denpa では、そのせいで「Pod は生きているのに画面だけ落ちる」状態が
 * 実機で34分続いた。合図はこちらで受け取り、閉じるのは止まる直前だけにする。
 */
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

// この場のプロセスの後始末を本当に外すので、終わったら元に戻す
const original = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
afterEach(() => {
    for (const signal of SIGNALS) {
        process.removeAllListeners(signal);
        for (const listener of original.get(signal) ?? []) {
            process.on(signal, listener as () => void);
        }
    }
});

describe('止まれの合図の受け取り', () => {
    test('先に入っていた後始末を外して、こちらだけが受ける', () => {
        let others = 0;
        const other = () => {
            others += 1;
        };
        process.on('SIGTERM', other);

        const received: string[] = [];
        const taken = takeOverSignals((signal) => received.push(signal));

        expect(taken).toBeGreaterThanOrEqual(1);
        expect(process.listenerCount('SIGTERM')).toBe(1);

        process.emit('SIGTERM');
        expect(received).toEqual(['SIGTERM']);
        // 外したものは呼ばれない (ここが呼ばれると listen が閉じていた)
        expect(others).toBe(0);
    });

    test('SIGINT も同じ扱い。合図の名前はそのまま渡す', () => {
        const received: string[] = [];
        takeOverSignals((signal) => received.push(signal));

        process.emit('SIGINT');
        expect(received).toEqual(['SIGINT']);
    });

    test('誰も入れていなくても壊れない', () => {
        for (const signal of SIGNALS) process.removeAllListeners(signal);

        expect(takeOverSignals(() => {})).toBe(0);
        expect(process.listenerCount('SIGTERM')).toBe(1);
    });
});
