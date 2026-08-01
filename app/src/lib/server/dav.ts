import { readdirSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { config } from './config';
import { serveFile } from './serve';

/**
 * WebDAV の PROPFIND を組み立てるところ。
 *
 * ライブラリのディレクトリをそのまま見せる。DBは見ない。
 * 実体がそのまま出るほうが、denpa 側の状態と食い違わない。
 */

export interface Entry {
    /** ライブラリからの相対パス。ルートは空文字 */
    path: string;
    name: string;
    isDirectory: boolean;
    size: number;
    modifiedAt: Date;
    contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
    '.mkv': 'video/x-matroska',
    '.m2ts': 'video/mp2t',
    '.ts': 'video/mp2t',
    '.mp4': 'video/mp4',
    '.jpg': 'image/jpeg',
    '.nfo': 'text/xml',
};

/**
 * ライブラリの外に出ないようにする。
 * `..` を含むパスをそのまま繋ぐと、ライブラリの外のファイルを取られる
 */
function resolve(path: string): string | null {
    const cleaned = normalize(path).replace(/^(\.\.(\/|\\|$))+/, '');
    if (cleaned.startsWith('..') || cleaned.includes('\0')) return null;
    const full = join(config.libraryDir, cleaned);
    return full.startsWith(config.libraryDir) ? full : null;
}

export function entryFor(path: string): Entry | null {
    const trimmed = path.replace(/^\/+|\/+$/g, '');
    const full = resolve(trimmed);
    if (full === null) return null;

    let stat: ReturnType<typeof statSync>;
    try {
        stat = statSync(full);
    } catch {
        return null;
    }

    const name = trimmed === '' ? '録画' : (trimmed.split('/').pop() ?? '');
    return {
        path: trimmed,
        name,
        isDirectory: stat.isDirectory(),
        size: stat.isDirectory() ? 0 : stat.size,
        modifiedAt: stat.mtime,
        contentType: stat.isDirectory()
            ? 'httpd/unix-directory'
            : (CONTENT_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream'),
    };
}

export function children(path: string): Entry[] {
    const trimmed = path.replace(/^\/+|\/+$/g, '');
    const full = resolve(trimmed);
    if (full === null) return [];

    let names: string[];
    try {
        names = readdirSync(full);
    } catch {
        return [];
    }

    return (
        names
            .map((name) => entryFor(trimmed === '' ? name : `${trimmed}/${name}`))
            .filter((entry): entry is Entry => entry !== null)
            // フォルダを先に、あとは名前順。Kodi はサーバの並びをそのまま出す
            .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
    );
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** パスの各要素を個別に encode する。区切りの / は残す */
function href(origin: string, path: string, isDirectory: boolean): string {
    const encoded = path
        .split('/')
        .filter((part) => part !== '')
        .map(encodeURIComponent)
        .join('/');
    const base = `${origin}/dav${encoded === '' ? '' : `/${encoded}`}`;
    return escapeXml(isDirectory ? `${base}/` : base);
}

export function propfind(origin: string, entries: Entry[]): string {
    const responses = entries
        .map((entry) => {
            const type = entry.isDirectory
                ? '<D:resourcetype><D:collection/></D:resourcetype>'
                : '<D:resourcetype/>';
            const length = entry.isDirectory ? '' : `<D:getcontentlength>${entry.size}</D:getcontentlength>`;
            return `  <D:response>
    <D:href>${href(origin, entry.path, entry.isDirectory)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(entry.name)}</D:displayname>
        ${type}
        ${length}
        <D:getcontenttype>${entry.contentType}</D:getcontenttype>
        <D:getlastmodified>${entry.modifiedAt.toUTCString()}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
        })
        .join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses}
</D:multistatus>`;
}

/**
 * `/dav` 以下のリクエストを捌く。
 *
 * SvelteKit のルートは GET/POST など決まったメソッドしか受けられず、
 * WebDAV の PROPFIND を書けない。フックの中で先に処理する。
 */
export function handleDav(request: Request, url: URL): Response | null {
    if (url.pathname !== '/dav' && !url.pathname.startsWith('/dav/')) return null;

    const path = decodeURIComponent(url.pathname.slice('/dav'.length));

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                // Kodi はここを見てサーバの種類を決める
                DAV: '1',
                Allow: 'OPTIONS, GET, HEAD, PROPFIND',
                'MS-Author-Via': 'DAV',
            },
        });
    }

    const entry = entryFor(path);
    if (entry === null) return new Response('not found', { status: 404 });

    if (request.method === 'PROPFIND') {
        // Depth: 0 は自分だけ、1 は自分と直下。Kodi は 1 で聞いてくる
        const depth = request.headers.get('depth') ?? '1';
        const entries = depth === '0' || !entry.isDirectory ? [entry] : [entry, ...children(path)];
        return new Response(propfind(url.origin, entries), {
            status: 207,
            headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        // 書き込み系は実装しない。外から書かれると実体とDBがずれる
        return new Response('method not allowed', {
            status: 405,
            headers: { Allow: 'OPTIONS, GET, HEAD, PROPFIND' },
        });
    }
    if (entry.isDirectory) return new Response('is a directory', { status: 405 });

    return serveFile(join(config.libraryDir, entry.path), entry.contentType, request);
}
