import { once } from 'node:events';
import { createWriteStream, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { EpgReader } from '../ts/eit';
import { ServiceFilter } from '../ts/service-filter';
import type { Program, Recording, Reservation, Service } from '../types';
import { config } from './config';
import { database, now, queryOne } from './db';
import { enqueue } from './encoder';
import { savePrograms } from './epg';
import { emit } from './events';
import { moveFile } from './fsx';
import { libraryPath, recordedPath } from './library';
import { writeNfo, writeThumbnail } from './metadata';
import { chunks } from './stream';
import { parseTitle } from './title';
import { openChannelStream } from './tuner';
import { notify } from './webhook';

/** 録画中のストリームを止めるための口。プロセス内にしか無いので再起動で失われる(起動時に失敗扱いにする) */
const active = new Map<number, AbortController>();

export function activeRecordingIds(): number[] {
    return [...active.keys()];
}

export function stopRecording(recordingId: number): void {
    active.get(recordingId)?.abort();
}

/** 通知用に録画の要点をまとめる */
function summary(recording: Recording) {
    return {
        id: recording.id,
        name: recording.name,
        service: recording.service_name,
        startAt: recording.start_at,
        endAt: recording.end_at,
    };
}

function fail(recordingId: number, error: string): void {
    /*
     * 理由を書けば状態は決まる (recordings.state は生成列)。
     * 掴むのも終わりなので、録り終えた時刻も同時に埋める
     */
    database()
        .prepare(
            `UPDATE recordings SET error = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
             WHERE id = ?`,
        )
        .run(error, now(), now(), recordingId);
    const rec = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', recordingId);
    if (rec !== undefined) {
        notify({
            event: 'recording.failed',
            text: `録画に失敗しました: ${rec.name} (${rec.service_name})`,
            recording: summary(rec),
            error,
        });
    }
    // 予約側には何も書かない。失敗したことは録画の行が持っている
}

function createRecording(reservation: Reservation): Recording {
    const service = queryOne<Service>('SELECT * FROM services WHERE id = ?', reservation.service_id);
    const program = queryOne<Program>('SELECT * FROM programs WHERE id = ?', reservation.program_id);

    /*
     * 名前と概要は**録り始める瞬間の番組表**から取る。
     *
     * 番組表は放送直前まで書き換わる (「[新]」が付く、サブタイトルが入る、
     * 誤字が直る)。予約の行はキーワードで当てた時点の値のままで、時刻が動いた
     * ときにしか更新していないので、そのまま写すと**古い名前で保存先に並ぶ**。
     *
     * 逆に、録り終えたあとは動かさない。番組表の行は24時間で消えるうえ、
     * ファイル名も .nfo も既に書いてある (docs/data.md)
     */
    const name = program?.name ?? reservation.name;
    const description = program?.description ?? reservation.description;
    const parsed = parseTitle(name);
    const at = now();

    const info = database()
        .prepare(
            // finished_at を入れないので、この行は「録画中」として読まれる
            `INSERT INTO recordings
                (reservation_id, program_id, service_id, service_name, name, series, subtitle,
                 description, start_at, end_at, audio_type, genre_detail, keep_original, cm_cut, codec,
                 created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            reservation.id,
            reservation.program_id,
            reservation.service_id,
            service?.name ?? '',
            name,
            parsed.series,
            parsed.subtitle,
            description,
            reservation.start_at,
            reservation.end_at,
            program?.audio_type ?? null,
            // 番組表の行は24時間で消える。録り直しのときにも要るので写しておく
            program?.genre_detail ?? null,
            reservation.keep_original,
            reservation.cm_cut,
            reservation.codec,
            at,
            at,
        );

    const id = Number(info.lastInsertRowid);
    // ファイル名は録画IDを含めるため、行を作ってからでないと決まらない
    const path = recordedPath({
        id,
        series: parsed.series,
        subtitle: parsed.subtitle,
        start_at: reservation.start_at,
    });
    database().prepare('UPDATE recordings SET ts_path = ? WHERE id = ?').run(path, id);

    return queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', id)!;
}

/**
 * 予約を録画に移す。ストリームの読み出しは待たずにバックグラウンドで走らせ、
 * 呼び出し側(スケジューラのtick)を塞がないようにする。
 */
export async function startRecording(reservation: Reservation): Promise<Recording> {
    const recording = createRecording(reservation);
    emit('recordings');
    const controller = new AbortController();
    active.set(recording.id, controller);

    notify({
        event: 'recording.started',
        text: `録画を開始しました: ${recording.name} (${recording.service_name})`,
        recording: summary(recording),
    });

    void pump(recording, controller).catch((error) => {
        active.delete(recording.id);
        fail(recording.id, String(error));
    });

    return recording;
}

/**
 * チューナーが空くのを少し待つ。
 *
 * 掴めない理由は「本当に足りない」だけとは限らない。番組の頭を数秒落としてでも
 * 録れたほうがいいので、すぐには諦めない。
 */
const OPEN_RETRIES = 5;
const OPEN_RETRY_WAIT = 2000;

async function openWithRetry(
    open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
    signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
    let last: unknown;
    for (let attempt = 0; attempt < OPEN_RETRIES; attempt++) {
        if (signal.aborted) throw new Error('録画が中止されました');
        try {
            return await open(signal);
        } catch (error) {
            last = error;
            if (attempt < OPEN_RETRIES - 1) {
                await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_WAIT));
            }
        }
    }
    throw new Error(`チューナーを ${OPEN_RETRIES} 回試して掴めませんでした: ${last}`);
}

/**
 * 放送の延長に追い付く。**録画中のTSに乗っている EIT[p/f] を見る。**
 *
 * mirakc に番組情報を聞き直していた頃と違って、**問い合わせる相手が要らない**。
 * いま録っているチャンネルのTSにそのまま流れてくるので、読むだけで分かる。
 *
 * 縮む方向には追わない。番組表が短くなったからといって録画を早く切ると、
 * 実際にはまだ流れていたときに取り返しがつかない。
 */
function extendIfLonger(recording: Recording, endAt: number): void {
    const current = queryOne<{ end_at: number }>('SELECT end_at FROM recordings WHERE id = ?', recording.id);
    if (current === undefined || endAt <= current.end_at) return;

    const at = now();
    database()
        .prepare('UPDATE recordings SET end_at = ?, updated_at = ? WHERE id = ?')
        .run(endAt, at, recording.id);
    if (recording.reservation_id !== null) {
        database()
            .prepare('UPDATE reservations SET end_at = ?, updated_at = ? WHERE id = ?')
            .run(endAt, at, recording.reservation_id);
    }
    const minutes = Math.round((endAt - current.end_at) / 60000);
    console.log(`[rec] 放送が延びました: ${recording.name} (+${minutes}分)`);
    emit('recordings');
    emit('reservations');
}

/** 実際に録れた長さを足す。再開したぶんも合算するので加算にする */
function addDuration(recordingId: number, ms: number): void {
    if (ms <= 0) return;
    database()
        .prepare('UPDATE recordings SET duration_ms = COALESCE(duration_ms, 0) + ? WHERE id = ?')
        .run(ms, recordingId);
}

/**
 * 録画中に拾った番組表を書き出す間隔。
 *
 * **ただで手に入るぶん。** 録画で開いているチャンネルには EIT[schedule] も
 * 流れてきているので、読んで捨てる理由が無い。番組表集めがそのチャンネルへ
 * 行く手間がまるごと省ける
 */
const EPG_SAVE_INTERVAL = 5 * 60_000;

async function pump(recording: Recording, controller: AbortController): Promise<void> {
    const path = recording.ts_path!;
    mkdirSync(dirname(path), { recursive: true });

    const service = queryOne<Service>('SELECT * FROM services WHERE id = ?', recording.service_id);
    if (service === undefined) {
        fail(recording.id, '局の情報がありません。チャンネルスキャンをやり直してください');
        active.delete(recording.id);
        return;
    }

    /*
     * **物理チャンネルを丸ごと開いて、こちらで局を選り分ける。**
     *
     * エージェントは中身を読まないので、1本の TS にその中継に乗っている局が
     * 全部流れてくる。そのまま保存すると1つの録画に複数の番組が入る
     * (実機の TOKYO MX は MX1 と MX2 が同居している)。
     */
    const filter = new ServiceFilter(service.service_id);
    /*
     * 同じ TS から番組表も読む。**延長の追従はここから。**
     * mirakc に番組情報を聞き直していた頃と違って、問い合わせる相手が要らない
     */
    const epg = new EpgReader();
    const eventId = recording.program_id === null ? null : recording.program_id % 100000;

    let written = 0;
    // 何を掴んでいるのかがチューナー画面に出る。番組名は載せず、IDだけ渡して向こうで引く
    const use = `rec ${recording.id}` as const;

    try {
        const stream = await openWithRetry(
            (signal) => openChannelStream(service.type, service.channel, signal, use),
            controller.signal,
        );

        // 追記で開く。再起動をまたいで録画を再開したときに、それまでの分を消さないため
        // (MPEG-TS は 188 バイトのパケットの並びなので、そのまま繋げても読める)
        const sink = createWriteStream(path, { flags: 'a' });
        // 実際に受け取っていた時間を測る。番組表の尺は予定でしかなく、
        // 途中で止めたときや掴むのに手間取ったときは実物と合わない。
        // 再開したときは足していく(ファイルも追記なので合計が実物になる)
        const from = Date.now();
        let savedEpgAt = from;

        try {
            for await (const chunk of chunks(stream)) {
                if (config.followOnair && epg.feed(chunk) && eventId !== null) {
                    const present = epg.present.get(service.service_id);
                    if (
                        present !== undefined &&
                        present.eventId === eventId &&
                        present.startAt !== null &&
                        present.duration !== null
                    ) {
                        extendIfLonger(recording, present.startAt + present.duration);
                    }
                    if (Date.now() - savedEpgAt >= EPG_SAVE_INTERVAL) {
                        savedEpgAt = Date.now();
                        savePrograms(epg.all());
                    }
                }

                const out = filter.filter(chunk);
                if (out.length === 0) continue;
                written += out.byteLength;
                if (!sink.write(out)) await once(sink, 'drain');
            }
        } finally {
            addDuration(recording.id, Date.now() - from);
            await new Promise<void>((resolve, reject) => {
                sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
            });
            // 途中で終わっても、読めたぶんの番組表は残す
            if (config.followOnair) savePrograms(epg.all());
        }
    } catch (error) {
        // 終了時刻に達して自分で abort した場合は正常終了。それ以外だけ失敗にする
        if (!controller.signal.aborted) {
            active.delete(recording.id);
            fail(recording.id, String(error));
            return;
        }
    } finally {
        active.delete(recording.id);
    }

    let size = written;
    try {
        size = statSync(path).size;
    } catch {
        // 統計が取れなくても書き込み量で代用する
    }

    if (size === 0) {
        fail(recording.id, 'ストリームから1バイトも受信できませんでした');
        return;
    }

    finish(recording.id, size);
}

/** 録画完了。エンコードするならキューに積み、しないならそのまま保存先に置く */
export function finish(recordingId: number, size: number): void {
    const at = now();
    // 録り終えた時刻が入った時点で「録画済み」になる (recordings.state は生成列)
    database()
        .prepare(`UPDATE recordings SET finished_at = ?, ts_size = ?, updated_at = ? WHERE id = ?`)
        .run(at, size, at, recordingId);

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', recordingId)!;
    const reservation =
        recording.reservation_id == null
            ? undefined
            : queryOne<{ encode: number }>(
                  'SELECT encode FROM reservations WHERE id = ?',
                  recording.reservation_id,
              );

    emit('recordings');
    notify({
        event: 'recording.finished',
        text: `録画が終わりました: ${recording.name} (${recording.service_name})`,
        recording: summary(recording),
    });

    if (reservation === undefined || reservation.encode) {
        enqueue(recording.id);
        return;
    }

    // エンコードしない設定なら生TSをそのまま保存先へ移す
    const dest = libraryPath(recording, '.m2ts');
    moveFile(recording.ts_path!, dest);
    writeNfo(recording, dest);
    void writeThumbnail(dest, (recording.end_at - recording.start_at) / 1000);
    database()
        .prepare(
            // 保存先に置いた時点で「視聴可能」になる
            `UPDATE recordings SET library_path = ?, ts_path = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(dest, now(), recording.id);
}

/**
 * プロセスが落ちた時点で録画中だった行を拾い直す。
 *
 * AbortController はメモリ上にしか無いので、再起動すると録画は止まったままになる。
 * まだ放送中のものは録り直しに行く。生TSは追記で開くので、落ちるまでに録れていた分は
 * そのまま残り、抜けるのは止まっていた間だけになる。
 * 放送が終わってしまったものは、もう取り返せないので失敗に倒す。
 */
export function recoverOrphanedRecordings(): { resumed: number; failed: number } {
    const orphans = database()
        .prepare(`SELECT * FROM recordings WHERE state = 'recording'`)
        .all() as Recording[];

    let resumed = 0;
    let failed = 0;
    const at = now();
    for (const orphan of orphans) {
        if (orphan.ts_path === null || orphan.end_at + config.endMargin <= at) {
            fail(orphan.id, 'アプリの再起動により録画が中断されました');
            failed++;
            continue;
        }

        const controller = new AbortController();
        active.set(orphan.id, controller);
        void pump(orphan, controller).catch((error) => {
            active.delete(orphan.id);
            fail(orphan.id, String(error));
        });
        console.log(`[boot] 録画を再開: ${orphan.name} (${orphan.service_name})`);
        resumed++;
    }
    if (resumed > 0) emit('recordings');
    return { resumed, failed };
}
