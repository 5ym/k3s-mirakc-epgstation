import { fail } from '@sveltejs/kit';
import { detectPlatform } from '$lib/play';
import { enabled as authEnabled } from '$lib/server/auth';
import { database, queryAll, queryOne } from '$lib/server/db';
import { cancel as cancelEncode, enqueue, pump } from '$lib/server/encoder';
import { emit } from '$lib/server/events';
import { deleteRecordingFiles, reconcile } from '$lib/server/files';
import { cancel, restore } from '$lib/server/reservations';
import { settings } from '$lib/server/settings';
import { encodeSource } from '$lib/source';
import type { EncodeJob, Recording, Reservation } from '$lib/types';

interface RecordingRow extends Recording {
    /** 直近のエンコード失敗の理由。詳細で見せる */
    encode_error: string | null;
    /** 動いているエンコード。無ければ null。行の状態としてそのまま出す */
    job_id: number | null;
    job_state: EncodeJob['state'] | null;
    job_phase: EncodeJob['phase'] | null;
    job_percent: number | null;
    job_eta_ms: number | null;
    job_log: string | null;
}

interface ReservationRow extends Reservation {
    service_name: string;
    rule_name: string | null;
}

/**
 * 予約と録画を1画面に並べる。
 *
 * 「これから何が録れるか」と「録れたものが今どうなっているか」は続きものなので、
 * 行き来せずに見えるほうがいい。左に予約、右に録画。
 */
export function load({ url, request }) {
    const showFinished = url.searchParams.get('all') === '1';
    const showDeleted = url.searchParams.get('deleted') === '1';

    const states = showFinished
        ? "('scheduled','conflict','recording','done','failed','canceled','missed')"
        : "('scheduled','conflict','recording')";
    const reservations = queryAll<ReservationRow>(
        `SELECT r.*, s.name AS service_name, rules.name AS rule_name
         FROM reservations r
         JOIN services s ON s.id = r.service_id
         LEFT JOIN rules ON rules.id = r.rule_id
         WHERE r.state IN ${states}
         -- 録画中は真っ先に見たいので先頭に固定する。
         -- そのあとは「これから」を近い順に、「終わったもの」を新しい順に。
         -- 全部まとめて降順にすると、これからの予約が一番遠いものから並んでしまう
         ORDER BY (r.state = 'recording') DESC,
                  CASE WHEN r.state IN ('scheduled', 'conflict') THEN 0 ELSE 1 END,
                  CASE WHEN r.state IN ('scheduled', 'conflict') THEN r.start_at END ASC,
                  r.start_at DESC
         LIMIT 300`,
    );

    /*
     * エンコードは録画一覧の行そのものに出す。
     *
     * 別のカードにして一覧の上に積んでいた頃は、エンコードが増えるたびに表が下へ
     * ずれてページごとスクロールバーが生えていた。同じ番組が2箇所に並んでもいた。
     * 「録れたものが今どうなっているか」の一形態なので、行の状態として出すのが素直。
     */
    const recordings = database()
        .prepare(
            `SELECT r.*, (
                 /*
                  * 失敗の理由は詳細で見せる。一覧には「失敗」とだけ出す。
                  *
                  * **いちばん新しいジョブが失敗していたときだけ**出す。
                  * 「失敗したジョブのうち最新」を拾っていた頃は、録り直して成功しても
                  * 前の失敗が消えずに残っていた
                  */
                 SELECT CASE WHEN j2.state = 'failed' THEN j2.error END FROM encode_jobs j2
                 WHERE j2.recording_id = r.id
                 ORDER BY j2.id DESC LIMIT 1
             ) AS encode_error,
             j.id AS job_id, j.state AS job_state, j.phase AS job_phase,
             j.percent AS job_percent, j.eta_ms AS job_eta_ms, j.log AS job_log
             FROM recordings r
             -- 動いているエンコードは録画1本につき高々1つ (encoder.enqueue が重複を弾く)
             LEFT JOIN encode_jobs j ON j.id = (
                 SELECT id FROM encode_jobs
                 WHERE recording_id = r.id AND state IN ('queued','running')
                 ORDER BY id DESC LIMIT 1
             )
             WHERE r.deleted_at IS ${showDeleted ? 'NOT NULL' : 'NULL'}
             -- 録画中のものは予約一覧に出ている。ここにも出すと同じ番組が2箇所に並ぶ
             AND r.state != 'recording'
             /*
              * 並びは放送日順に固定する。エンコードが始まったものを上へ動かしていた頃は、
              * 眺めている間に行が飛んで、どれを見ていたのか分からなくなっていた
              */
             ORDER BY r.start_at DESC
             LIMIT 300`,
        )
        .all() as RecordingRow[];

    return {
        reservations,
        recordings,
        showFinished,
        showDeleted,
        /*
         * 再生リンクの宛先。ブラウザで決めると、判定できるまでボタンが出ず
         * 読み込み直後に一瞬消えて見える。UA だけで分かる分はここで決めておき、
         * iPad (Macintosh を名乗る) だけブラウザ側で直す。
         *
         * origin をサーバで作れるのは PROTOCOL_HEADER を渡しているため
         * (k3s/deployment.yaml)。素の adapter-node は https と決め打つ
         */
        platform: detectPlatform(request.headers.get('user-agent') ?? ''),
        origin: url.origin,
        /*
         * プレイヤーに渡すURLに埋める資格情報。
         * VLC も Infuse もベーシック認証のダイアログを出さないので、URL に入れるしかない。
         *
         * BASIC_AUTH_SCOPE=files だとこの画面自体は素通しなので、画面を開ければ
         * パスワードも見える。画面の前段に別の認証を置いている前提の設定。
         */
        credentials: authEnabled()
            ? { user: settings().basicAuthUser, password: settings().basicAuthPassword }
            : undefined,
    };
}

/** フォームの id から録画を引く。どのアクションも最初にこれを通る */
function target(form: FormData): Recording | undefined {
    const id = Number(form.get('id'));
    if (!Number.isFinite(id)) return undefined;
    return queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', id);
}

export const actions = {
    delete: async ({ request }) => {
        const recording = target(await request.formData());
        if (recording === undefined) return fail(400, { message: '録画が見つかりません' });
        deleteRecordingFiles(recording, '手動削除');
        return { success: true };
    },

    reencode: async ({ request }) => {
        const recording = target(await request.formData());
        if (recording === undefined) return fail(400, { message: '録画が見つかりません' });
        // 元になるのは生TS。エンコード済みを元に録り直しても画質は戻らない
        if (encodeSource(recording) === null) {
            return fail(400, { message: '生TSが残っていないため再エンコードできません' });
        }
        enqueue(recording.id);
        pump();
        return { success: true };
    },

    cancelEncode: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'ジョブIDが不正です' });
        cancelEncode(id);
        return { success: true };
    },

    reconcile: () => {
        // 「実体と照合」ボタン。外から消した分をすぐ一覧に反映したいとき用
        const result = reconcile();
        // 押した本人以外の画面も更新する。同じものを見ている端末が食い違うのを防ぐ
        emit('recordings');
        return { success: true, reconcile: result };
    },

    /** 取り消した予約を戻す。ルールは作り直さないので、ここからしか戻せない */
    restore: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: 'IDが不正です' });
        try {
            await restore(id);
        } catch (error) {
            return fail(400, { message: String(error) });
        }
        return { success: true };
    },

    cancel: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        if (!Number.isFinite(id)) return fail(400, { message: '予約IDが不正です' });
        await cancel(id);
        return { success: true };
    },
};
