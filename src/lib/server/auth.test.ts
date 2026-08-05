import { describe, expect, test } from 'bun:test';
import { generatePassword, isFilePath, isOpenPath } from './auth';

/**
 * どの口をどう守るか。
 *
 * **プレイヤーが来る口だけは、いつでもベーシック認証。** VLC も Kodi も Infuse も
 * ログイン画面へのリダイレクトを扱えないので、ここを OIDC にすると再生できなくなる。
 */
describe('ファイルを取りに来る口', () => {
    test('録画の配信と WebDAV', () => {
        expect(isFilePath('/api/recordings/12/file')).toBe(true);
        expect(isFilePath('/dav')).toBe(true);
        expect(isFilePath('/dav/2026/番組.mkv')).toBe(true);
    });

    test('画面と、それ以外の API は含まない', () => {
        expect(isFilePath('/')).toBe(false);
        expect(isFilePath('/settings')).toBe(false);
        // 同じ録画でも、コマの切り出しは画面から呼ぶもの
        expect(isFilePath('/api/recordings/12/frame')).toBe(false);
        // 似ているだけの道。前方一致で緩めない
        expect(isFilePath('/api/recordings/12/file/extra')).toBe(false);
        expect(isFilePath('/davos')).toBe(false);
    });
});

/**
 * ログインの入口。**ここを守ると入れなくなる** (ログイン画面へ行くのに
 * ログインが要る、という輪になる)。
 */
describe('素通しにする口', () => {
    test('ログインとログアウト', () => {
        expect(isOpenPath('/login')).toBe(true);
        expect(isOpenPath('/login/callback')).toBe(true);
        expect(isOpenPath('/login/out')).toBe(true);
        expect(isOpenPath('/logout')).toBe(true);
    });

    /*
     * **生死確認。** Kubernetes の livenessProbe と compose の healthcheck が叩く。
     * 守ると Pod が再起動を繰り返す — 掛ける範囲を選べるのをやめたときに実際に踏んだ
     */
    test('生死確認', () => {
        expect(isOpenPath('/api/health')).toBe(true);
    });

    test('似た名前は素通しにしない', () => {
        expect(isOpenPath('/loginx')).toBe(false);
        expect(isOpenPath('/logoutx')).toBe(false);
        expect(isOpenPath('/api/healthz')).toBe(false);
        expect(isOpenPath('/')).toBe(false);
    });
});

/*
 * **URLに埋め込める文字だけで作る。** このパスワードは再生リンクの URL に
 * 入る (`http://denpa:xxx@.../file`) ので、`:` `@` `/` `#` `?` が混ざると
 * URL として割れる。紛らわしい文字 (0/O、1/l/I) も Kodi で手入力するときに困る
 */
describe('パスワードを作る', () => {
    test('24文字。URLを壊さない文字だけ', () => {
        for (let i = 0; i < 50; i++) {
            expect(generatePassword()).toMatch(/^[a-zA-Z2-9]{24}$/);
        }
    });

    test('紛らわしい文字は使わない', () => {
        const all = Array.from({ length: 200 }, () => generatePassword()).join('');
        for (const char of '0O1lI') expect(all).not.toContain(char);
    });

    test('毎回違う', () => {
        const made = new Set(Array.from({ length: 100 }, () => generatePassword()));
        expect(made.size).toBe(100);
    });
});
