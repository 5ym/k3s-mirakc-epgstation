/**
 * WebSocket に繋ぐための使い捨ての札。
 *
 * **ブラウザは WebSocket の握手に `Authorization` を付けてくれない。** 画面が
 * ベーシック認証を通っていても、そこから張る WebSocket は素通しで届いてしまう。
 * チューナーを掴む口をそのまま開けておくわけにはいかない。
 *
 * そこで、**認証を通った画面だけが取れる札**を1枚配り、それを URL に付けて
 * 繋いでもらう。札の発行 (`/api/live/ticket`) は普通の HTTP なので、
 * ベーシック認証も OIDC も信頼した網も**そのまま効く**。
 *
 * **1回使ったら消す。** URL は履歴にもログにも残るので、残しておくと拾った人が
 * 繋げてしまう。寿命も短くしてある (取ってすぐ繋ぐだけの用なので、これで足りる)。
 */

/** 札の寿命。取ってすぐ繋ぐだけなので短くてよい */
const LIFETIME = 30_000;

const issued = new Map<string, number>();

/** 期限切れを片付ける。**配るときと使うときに掃く** (別に走らせるほどの量ではない) */
function sweep(at: number): void {
    for (const [token, until] of issued) {
        if (until <= at) issued.delete(token);
    }
}

/** 1枚配る */
export function issue(at: number = Date.now()): string {
    sweep(at);
    const token = crypto.randomUUID();
    issued.set(token, at + LIFETIME);
    return token;
}

/** 使う。**使えるのは1回だけ** */
export function redeem(token: string | null, at: number = Date.now()): boolean {
    if (token === null) return false;
    sweep(at);
    return issued.delete(token);
}

/** テスト用。持ち越した札で次のテストが通ってしまわないように */
export function forget(): void {
    issued.clear();
}
