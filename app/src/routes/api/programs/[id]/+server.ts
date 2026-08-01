import { error, json } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import type { ProgramDetail } from '$lib/types';

/**
 * 番組の詳細。予約一覧・録画一覧の行から開くときに使う。
 *
 * 一覧に最初から詰めて返すと、出演者やあらすじが 300 件ぶん載って重くなる。
 * 開いた1件だけ取りに来てもらう。
 *
 * EPG は古い番組を消していくので、録画からは引けないことがある。
 * その場合は 404 を返し、画面は録画が持っている分だけを出す。
 */
export function GET({ params }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(400, '番組IDが不正です');

    const program = queryOne<ProgramDetail>(
        `SELECT p.name, p.description, p.extended, p.genre_detail, p.audios,
                p.video_type, p.video_resolution, p.is_free, p.start_at, p.end_at,
                s.name AS service_name
         FROM programs p JOIN services s ON s.id = p.service_id
         WHERE p.id = ?`,
        id,
    );
    if (program === undefined) error(404, '番組が見つかりません');

    return json(program);
}
