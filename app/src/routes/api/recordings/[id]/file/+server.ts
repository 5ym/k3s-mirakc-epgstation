import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { error } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import type { Recording } from '$lib/types';

/**
 * 録画ファイルをそのまま配る。
 *
 * mpv / VLC / Infuse に URL を渡して直接再生させるための口。
 * 早送りできる必要があるので Range に対応する(対応していないと、
 * プレイヤーによっては全部落とし終わるまでシークできない)。
 */
export async function GET({ params, request, setHeaders }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(400, '録画IDが不正です');

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL', id);
    if (recording === undefined) error(404, '録画が見つかりません');

    // エンコード済みがあればそちら、無ければ生TS
    const path = recording.library_path ?? recording.ts_path;
    if (path === null) error(404, 'ファイルがありません');

    let size: number;
    try {
        size = statSync(path).size;
    } catch {
        error(404, 'ファイルが実体としてありません');
    }

    const type = path.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp2t';
    setHeaders({ 'Accept-Ranges': 'bytes' });

    const range = request.headers.get('range');
    const match = range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match === null) {
        return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
            headers: { 'Content-Type': type, 'Content-Length': String(size) },
        });
    }

    // bytes=100-  も  bytes=-500 (末尾から)  も来る
    const [, fromRaw, toRaw] = match;
    let from: number;
    let to: number;
    if (fromRaw === '') {
        const suffix = Number(toRaw);
        if (!Number.isFinite(suffix) || suffix <= 0) error(416, 'Range が不正です');
        from = Math.max(0, size - suffix);
        to = size - 1;
    } else {
        from = Number(fromRaw);
        to = toRaw === '' ? size - 1 : Math.min(Number(toRaw), size - 1);
    }
    if (!Number.isFinite(from) || from >= size || to < from) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }

    return new Response(
        Readable.toWeb(createReadStream(path, { start: from, end: to })) as unknown as ReadableStream,
        {
            status: 206,
            headers: {
                'Content-Type': type,
                'Content-Length': String(to - from + 1),
                'Content-Range': `bytes ${from}-${to}/${size}`,
            },
        },
    );
}
