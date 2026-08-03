import { fail } from '@sveltejs/kit';
import { queryAll } from '$lib/server/db';
import { stats as logoStats, sweep } from '$lib/server/logo';
import { getChannels, getEpgProgress, getServices, getTuners, ping } from '$lib/server/mirakc';
import { refresh, settle, settleState, start, stop } from '$lib/server/scan';
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
        // 局の取り込みの進み具合。押した後どうなっているのかを出すため
        settle: settleState(),
        /*
         * 局ロゴを何局ぶん持っているか。
         *
         * mirakc はロゴを集めないので denpa が放送波から拾っているが、
         * 拾えたかどうかを確かめる場所がどこにも無かった。番組表にロゴが
         * 出ないとき、取れていないのか出し方が悪いのかを見分けられるようにする
         */
        logos: logoStats(),
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

    /**
     * 局を取り直す。
     *
     * mirakc 側が1局ずつ選局して調べ終えるのを待つので、押した瞬間には終わらない。
     * ここでは待たずに始めるだけにして、埋まっていく様子は画面が知らせで受け取る
     * (取り込むたびに `services` が飛ぶ)。
     */
    resync: () => {
        void settle();
        return { success: true, scan: '局を取り込んでいます。増えなくなるまで続けます' };
    },

    /**
     * 局ロゴを取りに行く。
     *
     * ロゴは放送波に数十秒〜数分に一度しか流れてこないので、押しても
     * その場では出ない。普段は10分ごとに少しずつ拾っている
     */
    logoSweep: () => {
        void sweep(3);
        return { success: true, scan: '局ロゴを取りに行っています。届くまで数分かかります' };
    },
};
