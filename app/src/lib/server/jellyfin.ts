import { existsSync } from 'node:fs';
import type { Program, Recording, Service } from '../types';
import { config } from './config';
import { db, now, queryAll, queryOne } from './db';
import { pruneEmptyDirs, removeIfExists } from './fsx';
import { removeSidecars } from './metadata';
import { reserve } from './reservations';

/**
 * Jellyfin との連携。
 *
 * 録画の削除は Jellyfin の UI から直接行う (ライブラリを読み書き可でマウントし、
 * Jellyfin 側のユーザーに「メディアの削除を許可」を付ける)。denpa は消しに行かず、
 * 消された結果をライブラリの実体と突き合わせて自分のDBに反映するだけにしている。
 * 視聴管理は Jellyfin が持っているものが唯一の正で、denpa 側には持たない。
 */

export function enabled(): boolean {
    return config.jellyfinUrl !== '' && config.jellyfinApiKey !== '';
}

/**
 * 新しい録画をすぐ Jellyfin に出したいときだけ使う任意の連携。
 * 未設定でも Jellyfin 自身のリアルタイム監視/定期スキャンで拾われるので必須ではない。
 */
export async function refreshLibrary(): Promise<void> {
    if (!enabled()) return;
    try {
        await api<void>('/Library/Refresh', { method: 'POST' });
    } catch (error) {
        console.error(`[jellyfin] ライブラリ更新に失敗: ${error}`);
    }
}

/** Jellyfin の API を叩く。204 や空ボディも扱えるようにしておく */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${config.jellyfinUrl}${path}`, {
        ...init,
        headers: {
            ...(init?.headers ?? {}),
            Accept: 'application/json',
            Authorization: `MediaBrowser Token="${config.jellyfinApiKey}"`,
        },
    });
    if (!res.ok) throw new Error(`jellyfin ${path} -> ${res.status} ${await res.text()}`);
    const text = await res.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
}

interface TunerHost {
    Id: string;
    Url: string;
    Type: string;
    FriendlyName?: string;
}

interface ListingProvider {
    Id: string;
    Path: string;
    Type: string;
}

interface LiveTvOptions {
    TunerHosts: TunerHost[];
    ListingProviders: ListingProvider[];
}

interface ScheduledTask {
    Id: string;
    Key: string;
}

/**
 * denpa を Jellyfin のライブTVチューナーとして登録する。
 *
 * Jellyfin の初回セットアップウィザードにはライブTVの項目が無く、本来は
 * ダッシュボードから手で追加することになる。M3U と XMLTV の2箇所を正しいURLで
 * 入れる必要があり間違えやすいので、こちらから登録できるようにしておく。
 *
 * 同じURLが既に入っていれば足さない。denpa が入れた古いURLが残っていれば消してから入れ直す。
 */
export async function registerLiveTv(
    origin: string,
    profile: string,
): Promise<{ playlist: string; guide: string; tunerAdded: boolean; guideAdded: boolean }> {
    if (!enabled()) throw new Error('JELLYFIN_URL / JELLYFIN_API_KEY が設定されていません');

    const playlist = `${origin}/api/iptv/playlist.m3u?profile=${profile}`;
    const guide = `${origin}/api/iptv/xmltv.xml`;

    const options = await api<LiveTvOptions>('/System/Configuration/livetv');

    // denpa が入れたものだけを対象に、URLが変わっていたら消してから入れ直す
    let tunerAdded = false;
    const tuner = options.TunerHosts.find((t) => t.Url === playlist);
    if (tuner === undefined) {
        for (const stale of options.TunerHosts.filter((t) => t.FriendlyName === 'denpa')) {
            await api<void>(`/LiveTv/TunerHosts?id=${stale.Id}`, { method: 'DELETE' });
        }
        await api<TunerHost>('/LiveTv/TunerHosts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Type: 'm3u',
                Url: playlist,
                FriendlyName: 'denpa',
                // 変換は denpa 側で済ませてあるので Jellyfin には触らせない
                AllowHWTranscoding: false,
                EnableStreamLooping: false,
                TunerCount: 0,
                UserAgent: '',
            }),
        });
        tunerAdded = true;
    }

    let guideAdded = false;
    if (!options.ListingProviders.some((l) => l.Path === guide)) {
        for (const stale of options.ListingProviders.filter(
            (l) => l.Type === 'xmltv' && l.Path.includes('/api/iptv/xmltv.xml'),
        )) {
            await api<void>(`/LiveTv/ListingProviders?id=${stale.Id}`, { method: 'DELETE' });
        }
        await api<ListingProvider>('/LiveTv/ListingProviders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Type: 'xmltv', Path: guide, EnableAllTuners: true }),
        });
        guideAdded = true;
    }

    // 登録しただけではチャンネルも番組表も反映されない。取り込みを促す
    await refreshGuide();

    return { playlist, guide, tunerAdded, guideAdded };
}

/** Jellyfin の「Refresh Guide」タスクを走らせる */
export async function refreshGuide(): Promise<void> {
    try {
        const tasks = await api<ScheduledTask[]>('/ScheduledTasks');
        const task = tasks.find((t) => t.Key === 'RefreshGuide');
        if (task === undefined) return;
        await api<void>(`/ScheduledTasks/Running/${task.Id}`, { method: 'POST' });
    } catch (error) {
        console.error(`[jellyfin] 番組表の更新に失敗: ${error}`);
    }
}

export interface JellyfinTimer {
    Id: string;
    ChannelName?: string;
    Name?: string;
    StartDate: string;
    EndDate: string;
    PrePaddingSeconds?: number;
    PostPaddingSeconds?: number;
    SeriesTimerId?: string;
}

export interface TimerImport {
    imported: number;
    /** シリーズ録画など、こちらで扱わないもの */
    skipped: number;
    /** 番組を特定できず Jellyfin 側に残したもの */
    failed: number;
    messages: string[];
}

/**
 * タイマーが指している denpa の番組を探す。
 *
 * Jellyfin のタイマーには前後マージン(PrePadding/PostPadding)が乗っているので、
 * それを外した範囲と一番重なる番組を採る。Jellyfin の ProgramId は Jellyfin 内部の
 * IDでこちらからは引けないため、チャンネル名と時刻で突き合わせる
 * (チャンネル名は denpa が M3U に書いたものがそのまま返ってくる)。
 */
export function findProgramForTimer(timer: JellyfinTimer): Program | undefined {
    if (timer.ChannelName === undefined) return undefined;
    const service = queryOne<Service>('SELECT * FROM services WHERE name = ?', timer.ChannelName);
    if (service === undefined) return undefined;

    const start = Date.parse(timer.StartDate) + (timer.PrePaddingSeconds ?? 0) * 1000;
    const end = Date.parse(timer.EndDate) - (timer.PostPaddingSeconds ?? 0) * 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;

    const candidates = queryAll<Program>(
        'SELECT * FROM programs WHERE service_id = ? AND start_at < ? AND end_at > ?',
        service.id,
        end,
        start,
    );
    if (candidates.length === 0) return undefined;

    // 一番長く重なっている番組を採る(前後マージンで隣の番組にも掛かるため)
    return candidates.reduce((best, p) => {
        const overlap = (a: Program) => Math.min(a.end_at, end) - Math.max(a.start_at, start);
        return overlap(p) > overlap(best) ? p : best;
    });
}

/**
 * Jellyfin で作られた録画タイマーを denpa の予約として取り込む。
 *
 * Jellyfin のライブTV画面で録画ボタンを押すとタイマーが作られるので、それを拾って
 * denpa の予約に変換し、Jellyfin 側のタイマーは消す。実際の録画は denpa が
 * 生TSから行うので、Jellyfin に録画させるより画質もCM検出も後処理も良い。
 * (Jellyfin 側に録画フォルダを設定しなければ、そもそも Jellyfin は録画できない)
 *
 * タイマー作成を知らせてくれるWebhookは無いので、定期的に見に行くしかない。
 * JSONを1本取るだけなので負荷はほとんど無い。
 */
export async function importTimers(): Promise<TimerImport> {
    const result: TimerImport = { imported: 0, skipped: 0, failed: 0, messages: [] };
    if (!enabled()) return result;

    const { Items } = await api<{ Items: JellyfinTimer[] }>('/LiveTv/Timers');
    for (const timer of Items ?? []) {
        // シリーズ録画は Jellyfin が番組表更新のたびにタイマーを作り直すため、
        // 消しても復活して取り合いになる。繰り返し録画は denpa のルールを使う
        if (timer.SeriesTimerId != null && timer.SeriesTimerId !== '') {
            result.skipped++;
            continue;
        }

        const program = findProgramForTimer(timer);
        if (program === undefined) {
            result.failed++;
            result.messages.push(
                `番組を特定できませんでした: ${timer.ChannelName ?? '?'} ${timer.Name ?? ''}`,
            );
            continue;
        }

        // 予約を作れてから Jellyfin 側を消す。逆順だと失敗したときに録り逃す
        await reserve(program.id, { priority: 3 });
        await api<void>(`/LiveTv/Timers/${timer.Id}`, { method: 'DELETE' });
        result.imported++;
        console.log(`[jellyfin] 録画予約を取り込みました: ${program.name}`);
    }

    return result;
}

/**
 * 実ファイルとサイドカーを消してDBに墓標を残す。行自体は履歴として残す。
 *
 * denpa から消す場合も、Jellyfin が消したのを後から拾う場合もここを通す。
 * 動画が既に無いケース(後者)でも、残った .nfo / サムネイル / 空フォルダの
 * 片付けは同じようにやる必要があるため。
 */
export function deleteRecordingFiles(recording: Recording, reason: string): void {
    if (recording.library_path !== null) {
        removeIfExists(recording.library_path);
        // .nfo を取り残すと Jellyfin に中身の無いエピソードが並び続ける
        removeSidecars(recording.library_path);
        pruneEmptyDirs(recording.library_path);
    }
    removeIfExists(recording.ts_path);
    db.prepare(
        `UPDATE recordings SET deleted_at = ?, library_path = NULL, ts_path = NULL, error = ?, updated_at = ? WHERE id = ?`,
    ).run(now(), reason, now(), recording.id);
}

/**
 * ライブラリの実体とDBを突き合わせる。
 *
 * Jellyfin から録画を消すと、こちらのDBには実体の無い行だけが残る。それを削除済みに
 * 倒して一覧から外し、空になったシリーズ/シーズンのフォルダも畳む。
 * 消えたものだけを見て、DBに無いファイルには触らない(手で置いたものを消さないため)。
 */
export function reconcile(): { checked: number; removed: number } {
    const recordings = queryAll<Recording>(
        `SELECT * FROM recordings WHERE library_path IS NOT NULL AND deleted_at IS NULL`,
    );

    let removed = 0;
    for (const recording of recordings) {
        if (existsSync(recording.library_path!)) continue;
        deleteRecordingFiles(recording, 'Jellyfin 側で削除されました');
        removed++;
        console.log(`[jellyfin] ライブラリから消えていたので削除済みにしました: ${recording.name}`);
    }

    return { checked: recordings.length, removed };
}
