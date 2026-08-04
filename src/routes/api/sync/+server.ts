import { json } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { sync } from '$lib/server/epg';
import { collectOnce } from '$lib/server/epg-collect';

/**
 * 番組表を今すぐ集め直す。定期実行 (EPG_COLLECT_INTERVAL) を待たずに反映したいとき用。
 * E2E でも「番組表が入った状態」を待たずに作るためにここを叩く。
 *
 * **局の取り込みと番組表集めの両方をやる。** mirakc に聞いていた頃は取り込むだけで
 * 済んだが、いまは集めるところから denpa の仕事なので、押した人が待つのはここ。
 *
 * 返す `programs` は**いま持っている総数**。この回で増えたぶんではない — 既に
 * 揃っている局は集め直さないので、増えた数だけを返すと「0 件しか無い」に見える。
 */
export async function POST() {
    await collectOnce();
    const result = await sync();
    return json({
        ...result,
        programs: queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM programs')?.n ?? 0,
    });
}
