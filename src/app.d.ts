/**
 * SvelteKit に渡す型。
 *
 * `locals` はリクエストの間だけ持ち回るもの。OIDC でログインしている人が
 * 居れば `hooks.server.ts` が入れる (居なければ undefined)。
 */
declare global {
    namespace App {
        interface Locals {
            user?: { subject: string; name: string };
        }
    }
}

export {};
