import { detectPlatform } from '$lib/play';
import { enabled as authEnabled } from './auth';
import { settings } from './settings';

/**
 * 再生リンクを組み立てるのに要るもの。**録画一覧と番組表で同じものを渡す。**
 *
 * どちらの画面からも録れたものをそのまま開けるので、宛先の決め方が食い違うと
 * 「一覧からは開くのに番組表からは開かない」になります。
 */
export interface PlayContext {
    platform: ReturnType<typeof detectPlatform>;
    origin: string;
    credentials?: { user: string; password: string };
}

/**
 * **宛先はサーバで決めておきます。** ブラウザで判定してから出すと、判定できるまで
 * ボタンが出ず、読み込み直後に一瞬消えて見えます。UA だけで分かるぶんはここで決め、
 * iPad (Macintosh を名乗る) だけブラウザ側で直します (`$lib/play.svelte.ts`)。
 *
 * `origin` をサーバで作れるのは `PROTOCOL_HEADER` を渡しているためです
 * (`k3s/deployment.yaml`)。素の adapter-node は https と決め打ちます。
 *
 * **資格情報は URL に埋めます。** VLC も Infuse もベーシック認証のダイアログを
 * 出さないので、そうするしかありません。**この画面まで来られている時点で持っている
 * 人**なので、URL の中に見えていても増える危険はありません (画面も守られています。
 * docs/auth.md)。
 */
export function playContext(request: Request, url: URL): PlayContext {
    return {
        platform: detectPlatform(request.headers.get('user-agent') ?? ''),
        origin: url.origin,
        credentials: authEnabled()
            ? { user: settings().basicAuthUser, password: settings().basicAuthPassword }
            : undefined,
    };
}
