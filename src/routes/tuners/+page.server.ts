import { fail } from '@sveltejs/kit';
import { queryAll } from '$lib/server/db';
import { getChannels, getEpgProgress, getServices, getTuners, ping } from '$lib/server/mirakc';
import { refresh, start, stop } from '$lib/server/scan';
import { cardStatus } from '$lib/server/scramble';
import type { ChannelType, Service } from '$lib/types';

const TYPES: ChannelType[] = ['GR', 'BS', 'CS'];

export async function load() {
    return {
        // 実際の状況はチューナー側が持っている。開いた時点で取りに行く
        scan: await refresh(),
        /*
         * 以下は相手待ちなので promise のまま返して後から流し込む。
         * スキャン中は mirakc が止まっていて応答しないので、待つと画面が出ない
         */
        tuners: getTuners().catch(() => []),
        channels: getChannels().catch(() => []),
        mirakc: ping(),
        card: cardStatus(),
        /*
         * スキャンの後、mirakc は局も番組表も一度捨てて集め直す。
         * 「まだ途中なのか、その局が取れていないのか」を見分けられるように、
         * mirakc 側の集まり具合をそのまま出す
         */
        mirakcServices: getServices().catch(() => []),
        epg: getEpgProgress().catch(() => []),
        // denpa が取り込み済みの局。mirakc が見つけたものとの差が分かる
        services: queryAll<Service>('SELECT * FROM services ORDER BY type, channel, service_id'),
    };
}

export const actions = {
    scan: async ({ request }) => {
        const form = await request.formData();
        const types = form
            .getAll('types')
            .map(String)
            .filter((t): t is ChannelType => TYPES.includes(t as ChannelType));
        if (types.length === 0) return fail(400, { message: 'スキャンする種別を選んでください' });

        const result = await start({ types });
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },

    /** 走っているスキャンを中断する。設定は書き換えないまま止まる */
    scanStop: async () => {
        const result = await stop();
        if (!result.stopped) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },
};
