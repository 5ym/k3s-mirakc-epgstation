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

export async function GET({ params, url }) {
    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', Number(params.id));
    if (recording === undefined) throw error(404, '録画が見つかりません');

    // 生TSを優先する。ロゴの位置は放送そのままの絵で決めたい
    const source = recording.ts_path ?? recording.library_path;
    if (source === null) throw error(404, 'ファイルがありません');

    const requested = Number(url.searchParams.get('at'));
    const at = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_AT;

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
            // 大きすぎると画面に収まらない。ロゴの位置を決めるにはこれで足りる
            '-vf',
            'scale=960:-2',
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
        },
    });
}
