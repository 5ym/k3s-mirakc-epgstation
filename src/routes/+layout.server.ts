import { enabled } from '$lib/server/oidc';

/**
 * ログインしている人。**OIDC を設定しているときだけ出る。**
 *
 * ここで出すのは名前だけ。誰であるかは `sub` が決めていて、そちらは画面に要らない
 * (出しても読めない文字列で、コピーされて困るものでもないが、使い道が無い)。
 */
export function load({ locals }) {
    return {
        // 素通し (LAN) で入っている人も居るので、有効かどうかとは別に持つ
        oidc: enabled(),
        user: locals.user ?? null,
    };
}
