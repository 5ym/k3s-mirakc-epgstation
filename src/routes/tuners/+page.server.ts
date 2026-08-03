import { fail } from '@sveltejs/kit';
import { queryAll, queryOne } from '$lib/server/db';
import { stats as logoStats, sweepNow, sweepState } from '$lib/server/logo';
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
 * mirakc が自分で回している仕事。掴んでいるのが denpa とは限らない。
 * (`/api/tuners` の `users[].id` が `job:` で始まり、User-Agent は付かない)
 */
const JOBS: Record<string, string> = {
    // 物理チャンネルを1つずつ選局して、そこに何局乗っているかを調べている
    'epg.scan-services': 'どの局が受信できるか調べています',
    'epg.update-schedules': '番組表 (EPG) を集めています',
    'epg.sync-clocks': '放送の時刻に合わせています',
};

/**
 * 掴んでいる相手を読める言葉に直す。
 *
 * mirakc が持っているのは User-Agent だけで、そこには ASCII しか載せられない
 * (ヘッダなので)。denpa は用途とIDだけを渡し、番組名はここで引き直す。
 * `Bun/1.3.14` と出ていた頃は、録画なのかロゴ集めなのかが画面から読めなかった。
 *
 * **mirakc 自身の仕事には User-Agent が無い。** 「不明」と出していた頃は、
 * いちばんよく居座っている相手 (番組表集め) が誰なのか分からなかった。
 */
function describe(user: { id: string; agent?: string }): string {
    const use = user.agent?.match(/denpa \(([^)]+)\)/)?.[1];
    if (use === undefined) {
        const job = user.id.match(/^job:(.+)$/)?.[1];
        if (job !== undefined) return `mirakc: ${JOBS[job] ?? job}`;
        return user.agent ?? user.id;
    }

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
        users: (tuner.users ?? []).map((user) => ({ ...user, label: describe(user) })),
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
     * 局ロゴを取りに行く。**チューナー2つで、衛星も混ぜて。**
     *
     * ロゴは放送波に数十秒〜数分に一度しか流れてこないので、押してもその場では
     * 出ない。どこまで進んだかを画面に流すので、押した人は待たなくていい。
     *
     * 衛星も対象にする。ロゴを運ぶ中継は1つだけで、当たれば数十秒で全局ぶんが
     * 揃い、外れは PAT を見た時点 (1秒ほど) で次へ行くので、待たせる時間は
     * 地上波と変わらない。当たり外れは覚えるので、二度目からは当たりだけを開く
     */
    logoSweep: async () => {
        const result = await sweepNow();
        if (!result.started) return fail(409, { message: result.message });
        return { success: true, scan: result.message };
    },
};
