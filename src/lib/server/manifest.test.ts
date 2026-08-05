import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { config } from './config';
import { appName, manifest } from './manifest';

/**
 * **同じ denpa を2つの名前で出している。** 両方をホーム画面に置くと、
 * 名前もアイコンも同じものが並んで見分けが付かない。
 */
describe('ホーム画面に置いたときの名前', () => {
    const original = config.pwaNames;
    beforeEach(() => {
        config.pwaNames = 'dp.l.doany.io=denpa 宅内';
    });
    afterEach(() => {
        config.pwaNames = original;
    });

    test('載っている名前で来たら、その表示名', () => {
        expect(appName('dp.l.doany.io')).toBe('denpa 宅内');
        // ブラウザが送ってくるものをそのまま見るので、大文字小文字は問わない
        expect(appName('DP.L.DOANY.IO')).toBe('denpa 宅内');
    });

    test('載っていない名前は denpa のまま', () => {
        expect(appName('dp.doany.io')).toBe('denpa');
        expect(appName('localhost')).toBe('denpa');
    });

    test('何も書かなければ全部 denpa', () => {
        config.pwaNames = '';
        expect(appName('dp.l.doany.io')).toBe('denpa');
    });

    test('いくつでも並べられる', () => {
        config.pwaNames = 'a.example=denpa A, b.example=denpa B';
        expect(appName('a.example')).toBe('denpa A');
        expect(appName('b.example')).toBe('denpa B');
    });

    test('= が無い書き方は読み捨てる', () => {
        config.pwaNames = 'dp.l.doany.io';
        expect(appName('dp.l.doany.io')).toBe('denpa');
    });

    test('名前は name と short_name の両方に入る', () => {
        const out = manifest('dp.l.doany.io') as { name: string; short_name: string };
        expect(out.name).toBe('denpa 宅内');
        // ホーム画面のアイコンの下に出るのはこちら
        expect(out.short_name).toBe('denpa 宅内');
    });

    test('id を名前ごとに分ける。片方がもう片方の入れ直しにならないように', () => {
        const lan = manifest('dp.l.doany.io') as { id: string };
        const outside = manifest('dp.doany.io') as { id: string };
        expect(lan.id).not.toBe(outside.id);
    });
});
