import { error } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { serveFile } from '$lib/server/serve';
import type { Recording } from '$lib/types';

/**
 * 録画ファイルをそのまま配る。
 * mpv / VLC / Infuse に URL を渡して直接再生させるための口。
 */
function respond(id: number, request: Request): Response {
    if (!Number.isFinite(id)) error(400, '録画IDが不正です');

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL', id);
    if (recording === undefined) error(404, '録画が見つかりません');

    // エンコード済みがあればそちら、無ければ生TS
    const path = recording.library_path ?? recording.ts_path;
    if (path === null) error(404, 'ファイルがありません');

    return serveFile(path, path.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp2t', request);
}

export function GET({ params, request }) {
    return respond(Number(params.id), request);
}

export function HEAD({ params, request }) {
    return respond(Number(params.id), request);
}
