import { basename } from 'node:path';
import { error } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { contentDisposition, serveFile } from '$lib/server/serve';
import type { Recording } from '$lib/types';

/**
 * 録画ファイルをそのまま配る。
 * VLC / Infuse / Kodi に URL を渡して直接再生させるための口。
 */
function respond(id: number, request: Request, download: boolean): Response {
    if (!Number.isFinite(id)) error(400, '録画IDが不正です');

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL', id);
    if (recording === undefined) error(404, '録画が見つかりません');

    /*
     * どのファイルを配るか。
     *
     * 基本はエンコード済み、無ければ生TS。ただし**エンコードが走っている間は
     * 生TSのほう**を配る。録り直しの最中は library_path がまだ古いファイルを
     * 指していて、しかもその古いファイルは終わり際に消えるので、
     * 押した瞬間によって出るものが変わっていた
     */
    const encoding =
        queryOne<{ n: number }>(
            `SELECT COUNT(*) AS n FROM encode_jobs
             WHERE recording_id = ? AND state IN ('queued', 'running')`,
            id,
        )?.n ?? 0;
    const path =
        encoding > 0 && recording.ts_path !== null
            ? recording.ts_path
            : (recording.library_path ?? recording.ts_path);
    if (path === null) error(404, 'ファイルがありません');

    // ?download=1 のときだけ添付にする。プレイヤーは inline のほうが素直に開く
    return serveFile(
        path,
        path.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp2t',
        request,
        contentDisposition(basename(path), download),
    );
}

export function GET({ params, request, url }) {
    return respond(Number(params.id), request, url.searchParams.get('download') === '1');
}

export function HEAD({ params, request, url }) {
    return respond(Number(params.id), request, url.searchParams.get('download') === '1');
}
