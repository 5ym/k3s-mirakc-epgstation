import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

/**
 * ファイルをそのまま返す。Range に対応する。
 *
 * mpv も VLC も Kodi も Range でシークする。対応していないと、
 * プレイヤーによっては全部落とし終わるまで早送りできない。
 */
export function serveFile(path: string, contentType: string, request: Request): Response {
    let size: number;
    try {
        size = statSync(path).size;
    } catch {
        return new Response('not found', { status: 404 });
    }

    const base = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
    if (request.method === 'HEAD') {
        return new Response(null, { headers: { ...base, 'Content-Length': String(size) } });
    }

    const stream = (from?: number, to?: number) =>
        Readable.toWeb(
            from === undefined ? createReadStream(path) : createReadStream(path, { start: from, end: to }),
        ) as unknown as ReadableStream;

    const range = request.headers.get('range');
    const match = range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match === null) {
        return new Response(stream(), { headers: { ...base, 'Content-Length': String(size) } });
    }

    // bytes=100-  も  bytes=-500 (末尾から)  も来る
    const [, fromRaw, toRaw] = match;
    let from: number;
    let to: number;
    if (fromRaw === '') {
        const suffix = Number(toRaw);
        if (!Number.isFinite(suffix) || suffix <= 0) {
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        from = Math.max(0, size - suffix);
        to = size - 1;
    } else {
        from = Number(fromRaw);
        to = toRaw === '' ? size - 1 : Math.min(Number(toRaw), size - 1);
    }
    if (!Number.isFinite(from) || from >= size || to < from) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }

    return new Response(stream(from, to), {
        status: 206,
        headers: {
            ...base,
            'Content-Length': String(to - from + 1),
            'Content-Range': `bytes ${from}-${to}/${size}`,
        },
    });
}
