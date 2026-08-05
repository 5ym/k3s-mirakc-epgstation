/**
 * ログインの控え。
 *
 * **DBに持ちます。** 署名した Cookie に中身を入れる手もありますが、それだと
 * 「この端末だけ切る」ができません。DBに1行あるだけなら消せます。
 * 他のものと同じ SQLite なので、置き場が増えるわけでもありません。
 */

import { config } from './config';
import { database, now, queryOne } from './db';
import { randomToken } from './oidc';

/** Cookie の名前。`__Host-` は http のときに付けられないので素の名前にする */
export const COOKIE = 'denpa_session';
/** ログインの途中 (state / nonce / verifier) を預ける先。callback で使って捨てる */
export const PENDING_COOKIE = 'denpa_login';
/** 途中で放り出されたログインを片付けるまで */
export const PENDING_TTL = 10 * 60;

export interface Session {
    id: string;
    subject: string;
    name: string;
    expires_at: number;
}

export function create(subject: string, name: string): Session {
    const id = randomToken();
    const at = now();
    const expiresAt = at + config.oidcSessionTtl;
    database()
        .prepare('INSERT INTO sessions (id, subject, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, subject, name, at, expiresAt);
    return { id, subject, name, expires_at: expiresAt };
}

/** 生きている控えだけ返す。切れていれば null (行はここでは消さない) */
export function find(id: string | undefined): Session | null {
    if (id === undefined || id === '') return null;
    const row = queryOne<Session>('SELECT id, subject, name, expires_at FROM sessions WHERE id = ?', id);
    if (row === undefined) return null;
    return row.expires_at > now() ? row : null;
}

export function destroy(id: string | undefined): void {
    if (id === undefined || id === '') return;
    database().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** 切れた控えを片付ける。消し忘れても害は無いが、溜め続ける理由も無い */
export function prune(): number {
    const info = database().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    return Number(info.changes);
}

/**
 * ログインを求めない相手か。**LAN からは今までどおり素通しにするため。**
 *
 * `OIDC_BYPASS_CIDR` はカンマ区切りで、IPv4 の CIDR (`10.10.0.0/16`) か
 * そのままの住所を書く。IPv6 は書いたとおりに一致したときだけ通す
 * (前置き長での判定は入れていない)。
 */
export function bypassed(address: string): boolean {
    return config.oidcBypassCidr
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .some((entry) => matches(address, entry));
}

export function matches(address: string, entry: string): boolean {
    // ::ffff:10.0.0.1 のような書き方で届くことがある
    const target = address.replace(/^::ffff:/i, '');
    const [network, bits] = entry.split('/');
    const left = toIpv4(target);
    const right = toIpv4(network.replace(/^::ffff:/i, ''));
    if (left === null || right === null) return target === network;

    const length = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(length) || length < 0 || length > 32) return false;
    if (length === 0) return true;
    // >>> で符号なしに戻す。32bit シフトは 0 シフトになるので上で外してある
    const mask = (0xffffffff << (32 - length)) >>> 0;
    return (left & mask) >>> 0 === (right & mask) >>> 0;
}

function toIpv4(value: string): number | null {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const byte = Number(part);
        if (byte > 255) return null;
        out = ((out << 8) | byte) >>> 0;
    }
    return out;
}
