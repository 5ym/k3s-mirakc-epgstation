import { config } from '$lib/server/config';
import { queryAll } from '$lib/server/db';
import { playlist } from '$lib/server/iptv';
import { findProfile } from '$lib/server/live';
import type { Service } from '$lib/types';

/**
 * Jellyfin の「M3U Tuner」に登録するプレイリスト。
 * 各チャンネルのURLは denpa の変換済みストリームを指すので、Jellyfin 側は
 * MPEG-2 のトランスコードではなくリマックスで済む。
 */
export function GET({ url }) {
    const services = queryAll<Service>('SELECT * FROM services ORDER BY type, channel');
    // Jellyfin から見た denpa のURL。同じクラスタ内からなら Service 名で引ける
    const origin = config.iptvOrigin === '' ? url.origin : config.iptvOrigin;
    // 既定は設定値。?profile= で切り替えられるようにして、両方を別チューナーとして
    // 登録することもできるようにしておく
    const requested = url.searchParams.get('profile');
    const profile = findProfile(requested)?.id ?? findProfile(config.liveProfile)?.id ?? 'h264';

    return new Response(playlist(services, origin, profile), {
        headers: {
            'Content-Type': 'audio/x-mpegurl; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
