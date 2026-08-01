import { json } from '@sveltejs/kit';
import { sync } from '$lib/server/epg';

/**
 * EPG を今すぐ取り直す。定期実行(EPG_SYNC_INTERVAL)を待たずに反映したいとき用。
 * E2E でも「番組表が入った状態」を待たずに作るためにここを叩く。
 */
export async function POST() {
    return json(await sync());
}
