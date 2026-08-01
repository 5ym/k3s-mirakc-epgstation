import { error } from '@sveltejs/kit';
import { start } from '$lib/server/live';

/**
 * Jellyfin のライブTVが開くストリーム。プロファイルは h264 / av1。
 *
 * レスポンスは終わらない。相手が切ると body がキャンセルされ、live.ts 側で
 * ffmpeg と Mirakurun への接続がまとめて閉じられる。切断が伝わってこない場合も
 * アイドル回収が拾うので、チューナーが掴まれたままにはならない。
 */
export async function GET({ params }) {
    const serviceId = Number(params.serviceId);
    if (!Number.isFinite(serviceId)) error(400, 'チャンネルIDが不正です');

    try {
        const { stream, contentType } = await start(serviceId, params.profile);
        return new Response(stream, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'no-store',
                // 逆プロキシに溜め込まれるとライブの意味が無くなる
                'X-Accel-Buffering': 'no',
            },
        });
    } catch (e) {
        error(503, String(e instanceof Error ? e.message : e));
    }
}
