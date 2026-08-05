import { describe, expect, test } from 'bun:test';
import { matches } from './session';

/**
 * ログインを求めない相手か。
 *
 * **LAN からは今までどおり素通しにする**ためのもの。ここが緩いと外から
 * 素通りできてしまうので、境界をきっちり押さえておく。
 */
describe('住所の照合', () => {
    test('CIDR の中と外', () => {
        expect(matches('10.10.0.1', '10.10.0.0/16')).toBe(true);
        expect(matches('10.10.255.254', '10.10.0.0/16')).toBe(true);
        // 隣の /16。1ビット違いを通してしまわないこと
        expect(matches('10.11.0.1', '10.10.0.0/16')).toBe(false);
        expect(matches('10.9.255.255', '10.10.0.0/16')).toBe(false);
    });

    test('境界の長さ', () => {
        // /32 は1台だけ
        expect(matches('192.168.1.5', '192.168.1.5/32')).toBe(true);
        expect(matches('192.168.1.6', '192.168.1.5/32')).toBe(false);
        // /0 は全部。書いた人がそう書いたなら通す
        expect(matches('8.8.8.8', '0.0.0.0/0')).toBe(true);
    });

    test('長さを書かなければ1台だけ', () => {
        expect(matches('10.0.0.1', '10.0.0.1')).toBe(true);
        expect(matches('10.0.0.2', '10.0.0.1')).toBe(false);
    });

    /*
     * IPv4 の住所が IPv6 の形で届くことがある。素で比べると
     * `::ffff:10.10.0.1` が `10.10.0.0/16` に当たらず、LAN から入れなくなる
     */
    test('IPv6 に包まれた IPv4 も解く', () => {
        expect(matches('::ffff:10.10.0.1', '10.10.0.0/16')).toBe(true);
        expect(matches('::FFFF:10.11.0.1', '10.10.0.0/16')).toBe(false);
    });

    test('IPv6 は書いたとおりに一致したときだけ', () => {
        // 前置き長での判定は入れていない。曖昧に通すより、当たらないほうがいい
        expect(matches('fd00::1', 'fd00::1')).toBe(true);
        expect(matches('fd00::2', 'fd00::1')).toBe(false);
        expect(matches('fd00::1', 'fd00::/8')).toBe(false);
    });

    test('壊れた指定では通さない', () => {
        expect(matches('10.0.0.1', '10.0.0.0/33')).toBe(false);
        expect(matches('10.0.0.1', '10.0.0.0/-1')).toBe(false);
        expect(matches('10.0.0.1', '10.0.0.0/abc')).toBe(false);
        expect(matches('10.0.0.1', '')).toBe(false);
        // 桁が溢れているもの。数として読めても住所ではない
        expect(matches('10.0.0.1', '10.0.0.256/24')).toBe(false);
    });
});
