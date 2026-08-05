import { describe, expect, test } from 'bun:test';
import { isFilePath, isOpenPath } from './auth';

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

    test('似た名前は素通しにしない', () => {
        expect(isOpenPath('/loginx')).toBe(false);
        expect(isOpenPath('/logoutx')).toBe(false);
        expect(isOpenPath('/')).toBe(false);
    });
});
