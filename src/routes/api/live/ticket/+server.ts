import { json } from '@sveltejs/kit';
import { issue } from '$lib/server/tickets';

/**
 * ライブ視聴の WebSocket に繋ぐための札を1枚配る。
 *
 * **ここは普通の HTTP なので、認証がそのまま効く** (`hooks.server.ts`)。
 * WebSocket の握手にはブラウザが `Authorization` を付けてくれないため、
 * 認証を通れることをここで示してもらってから繋いでもらう (`tickets.ts`)。
 */
export function POST() {
    return json({ ticket: issue() });
}
