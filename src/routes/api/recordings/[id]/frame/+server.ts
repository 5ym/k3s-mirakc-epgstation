import { error } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { queryOne } from '$lib/server/db';
import type { Recording } from '$lib/types';

/**
 * 録画から1コマだけ切り出して返す。
 *
 * 局ロゴの位置を画面から教えてもらうために使う。ロゴは番組のどこにでも出ている
 * ので、頭から少し入ったところを既定にしてある (頭は前番組やCMのことがある)。
 *
 * 動画をまるごとブラウザへ流して止めてもらう手もあるが、MPEG-2 の TS も
 * AV1 の mkv もブラウザは素直に再生できない。1枚の JPEG にして渡す。
 */

/** 既定で切り出す位置。頭すぎるとCMや前番組に当たる */
const DEFAULT_AT = 300;
/** 待ち時間の上限。TS のシークは重いことがある */
const TIMEOUT = 30_000;
/** 画面に出す幅。ロゴの位置を決めるにはこれで足りる */
const WIDTH = 960;

/**
 * 元の映像の大きさ。**表示上の縦横比ではなく、記録されているコマの大きさ**。
 *
 * 地上波のHDは 1440×1080 で記録され、横に引き伸ばして 16:9 に見せている
 * (画素が正方形ではない)。logoframe が見るのはこの 1440×1080 のほうなので、
 * 画面で囲ってもらった座標はここへ戻して渡す必要がある。
 */
async function sourceSize(input: string): Promise<{ width: number; height: number } | null> {
    try {
        const proc = Bun.spawn(
            [
                config.ffprobe,
                '-v',
                'error',
                '-select_streams',
                'v:0',
                '-show_entries',
                'stream=width,height',
                '-of',
                'csv=p=0',
                input,
            ],
            { stdout: 'pipe', stderr: 'ignore' },
        );
        const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
        await proc.exited;
        const [width, height] = out.trim().split(',').map(Number);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0) return null;
        return { width, height };
    } catch {
        return null;
    }
}

export async function GET({ params, url }) {
    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', Number(params.id));
    if (recording === undefined) throw error(404, '録画が見つかりません');

    // 生TSを優先する。ロゴの位置は放送そのままの絵で決めたい
    const source = recording.ts_path ?? recording.library_path;
    if (source === null) throw error(404, 'ファイルがありません');

    const requested = Number(url.searchParams.get('at'));
    const at = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_AT;

    const size = await sourceSize(source);

    const proc = Bun.spawn(
        [
            config.ffmpeg,
            '-v',
            'error',
            // -ss を -i の前に置くと、キーフレームまで飛んでから読み始めるので速い
            '-ss',
            String(at),
            '-i',
            source,
            '-frames:v',
            '1',
            /*
             * **放送どおりの縦横比で出す。**
             *
             * 地上波のHDは 1440×1080 で記録されていて、画素が正方形ではない。
             * `scale=960:-2` は記録されている大きさだけを見るので、そのままだと
             * 960×720 の 4:3 になり、横に潰れた絵が出ていた。
             * 表示上の比 (dar) から高さを出して、正方形の画素に直す
             */
            '-vf',
            `scale=${WIDTH}:trunc(${WIDTH}/dar/2)*2,setsar=1`,
            '-f',
            'image2',
            '-c:v',
            'mjpeg',
            'pipe:1',
        ],
        { stdout: 'pipe', stderr: 'ignore' },
    );

    const timer = setTimeout(() => proc.kill(), TIMEOUT);
    const image = await new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer();
    await proc.exited;
    clearTimeout(timer);

    // 指定した位置が録画の終わりより後ろだと1枚も出てこない
    if (image.byteLength === 0) throw error(404, 'その位置のコマを取り出せませんでした');

    return new Response(image, {
        headers: {
            'Content-Type': 'image/jpeg',
            // 同じ位置なら中身は変わらない
            'Cache-Control': 'private, max-age=3600',
            /*
             * 記録されているコマの大きさ。画面で囲ってもらった座標を
             * ここへ戻して logoframe に渡す (LogoArea.svelte)。
             * 出している絵は縦横比を直したものなので、絵の大きさからは逆算できない
             */
            'X-Source-Width': String(size?.width ?? ''),
            'X-Source-Height': String(size?.height ?? ''),
        },
    });
}
