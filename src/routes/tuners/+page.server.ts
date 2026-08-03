import { fail } from '@sveltejs/kit';
import { queryAll, queryOne } from '$lib/server/db';
import { stats as logoStats, sweepGround, sweepState } from '$lib/server/logo';
import {
    getChannels,
    getEpgProgress,
    getServices,
    getTuners,
    type MirakcTuner,
    ping,
} from '$lib/server/mirakc';
import { refresh, restartMirakc, start, stop } from '$lib/server/scan';
import { cardStatus } from '$lib/server/scramble';
import type { ChannelType, Service } from '$lib/types';

const TYPES: ChannelType[] = ['GR', 'BS', 'CS'];

interface TunerUser {
    id: string;
    priority: number;
    agent?: string;
    /** 画面に出す言葉。denpa 以外の相手は User-Agent をそのまま出す */
    label: string;
}

/**
 * 掴んでいる相手を読める言葉に直す。
 *
 * mirakc が持っているのは User-Agent だけで、そこには ASCII しか載せられない
 * (ヘッダなので)。denpa は用途とIDだけを渡し、番組名はここで引き直す。
 * `Bun/1.3.14` と出ていた頃は、録画なのかロゴ集めなのかが画面から読めなかった。
 */
function describe(agent: string | undefined): string {
    const use = agent?.match(/denpa \(([^)]+)\)/)?.[1];
    if (use === undefined) return agent ?? '不明';

    const recording = use.match(/^rec (\d+)$/);
    if (recording !== null) {
        const row = queryOne<{ name: string }>(
            'SELECT name FROM recordings WHERE id = ?',
            Number(recording[1]),
        );
        return row === undefined ? '録画' : `録画: ${row.name}`;
    }

    const logo = use.match(/^logo \S+\/(\S+)$/);
    if (logo !== null) return `局ロゴ収集 (${logo[1]})`;

    return use;
}

function withLabels(tuners: MirakcTuner[]): (Omit<MirakcTuner, 'users'> & { users: TunerUser[] })[] {
    return tuners.map((tuner) => ({
        ...tuner,
        users: (tuner.users ?? []).map((user) => ({ ...user, label: describe(user.agent) })),
    }));
}

export async function load() {
    return {
        // 実際の状況はチューナー側が持っている。開いた時点で取りに行く
        scan: await refresh(),
        /*
         * 以下は相手待ちなので promise のまま返して後から流し込む。
         * スキャン中は mirakc が止まっていて応答しないので、待つと画面が出ない
         */
        // 掴んでいる相手は User-Agent でしか分からない。読める言葉に直してから渡す
        tuners: getTuners()
            .then(withLabels)
            .catch(() => []),
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
        /*
         * 局ロゴを何局ぶん持っているか。
         *
         * mirakc はロゴを集めないので denpa が放送波から拾っているが、
         * 拾えたかどうかを確かめる場所がどこにも無かった。番組表にロゴが
         * 出ないとき、取れていないのか出し方が悪いのかを見分けられるようにする
         */
        logos: logoStats(),
        /*
         * 取りに行っている最中の様子。1チャンネルに数分かかるので、出さないと
         * 押しても何も起きていないように見える
         */
        logoSweep: sweepState(),
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
     * mirakc を入れ直す。
     *
     * **局が足りないときに効くのはこれだけ。** 局を調べているのは mirakc 側で、
     * denpa がそこから取り込み直しても mirakc が知らないものは増えない。
     * mirakc は起動時に局と番組表を取りに行くので、入れ直すのが一番速い道になる。
     * 揃うたびに `/events` で知らせが来るので、denpa は待ち構えるだけでいい。
     */
    restartMirakc: async ({ request }) => {
        const form = await request.formData();
        const result = await restartMirakc(form.get('forget') === 'on');
        if (!result.ok) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },

    /**
     * 局ロゴを取りに行く。**地上波だけ、チューナー2つで。**
     *
     * ロゴは放送波に数十秒〜数分に一度しか流れてこないので、押してもその場では
     * 出ない。どこまで進んだかを画面に流すので、押した人は待たなくていい。
     *
     * 衛星を混ぜないのは、BS/CS のロゴが地上波よりさらに来ないため。1チャンネルに
     * 10分開いて何も来ないのが普通で、押した人を待たせるだけになる。そちらは
     * 10分ごとの定期取得に任せる (1つの中継で網羅できるので、いつかは埋まる)
     */
    logoSweep: async () => {
        const result = await sweepGround();
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },
};
