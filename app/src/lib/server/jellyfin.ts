import { existsSync } from 'node:fs';
import type { Recording } from '../types';
import { config } from './config';
import { database, now, queryAll } from './db';
import { pruneEmptyDirs, removeIfExists } from './fsx';
import { removeSidecars } from './metadata';
import { settings } from './settings';

/**
 * Jellyfin との連携。
 *
 * 録画の削除は Jellyfin の UI から直接行う (ライブラリを読み書き可でマウントし、
 * Jellyfin 側のユーザーに「メディアの削除を許可」を付ける)。denpa は消しに行かず、
 * 消された結果をライブラリの実体と突き合わせて自分のDBに反映するだけにしている。
 * 視聴管理は Jellyfin が持っているものが唯一の正で、denpa 側には持たない。
 */

export function enabled(): boolean {
    const { jellyfinUrl, jellyfinApiKey } = settings();
    return jellyfinUrl !== '' && jellyfinApiKey !== '';
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
    const { jellyfinUrl, jellyfinApiKey } = settings();
    const res = await fetch(`${jellyfinUrl}${path}`, {
        ...init,
        headers: {
            ...(init?.headers ?? {}),
            Accept: 'application/json',
            Authorization: `MediaBrowser Token="${jellyfinApiKey}"`,
        },
    });
    if (!res.ok) throw new Error(`jellyfin ${path} -> ${res.status} ${await res.text()}`);
    const text = await res.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
}

/**
 * 管理者のIDとパスワードから API キーを発行する。
 *
 * APIキーは Jellyfin のセットアップを終えてからでないと作れないので、
 * 「denpa を動かす前に用意しておく」ことができない。ここで発行してDBに保存し、
 * パスワードは保存しない(この関数の外へ出さない)。
 */
export async function issueApiKey(url: string, username: string, password: string): Promise<string> {
    const base = url.replace(/\/+$/, '');
    // 認証にはクライアント情報のヘッダが要る。無いと Jellyfin は 400 を返す
    const auth = 'MediaBrowser Client="denpa", Device="denpa", DeviceId="denpa-setup", Version="1.0"';

    const login = await fetch(`${base}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth },
        body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (!login.ok) {
        throw new Error(`ログインに失敗しました (${login.status})。IDとパスワードを確認してください`);
    }
    const { AccessToken } = (await login.json()) as { AccessToken: string };

    const token = `MediaBrowser Token="${AccessToken}"`;
    const created = await fetch(`${base}/Auth/Keys?app=denpa`, {
        method: 'POST',
        headers: { Authorization: token },
    });
    if (!created.ok) throw new Error(`APIキーの発行に失敗しました (${created.status})`);

    // 発行APIは本体を返さないので、一覧から自分のぶんを拾う
    const list = await fetch(`${base}/Auth/Keys`, {
        headers: { Authorization: token, Accept: 'application/json' },
    });
    if (!list.ok) throw new Error(`APIキーの取得に失敗しました (${list.status})`);
    const { Items } = (await list.json()) as { Items: { AccessToken: string; AppName: string }[] };

    const key = Items.filter((i) => i.AppName === 'denpa').at(-1)?.AccessToken;
    if (key === undefined) throw new Error('発行したAPIキーが見つかりませんでした');
    return key;
}

interface VirtualFolder {
    Name: string;
    Locations: string[];
    CollectionType?: string;
    ItemId: string;
}

interface JellyfinUser {
    Id: string;
    Name: string;
    Policy?: { IsAdministrator?: boolean; EnableContentDeletion?: boolean };
}

/**
 * ライブラリの追加とメタデータ設定。
 *
 * 日本の放送番組は TheTVDB / TMDB にほぼ載っていないので、インターネット取得を
 * 切って denpa が書いた .nfo を読ませる。これを有効なままにすると、空の検索結果で
 * せっかくのメタデータが上書きされる。
 */
export async function setupLibrary(
    libraryPath: string,
): Promise<{ created: boolean; renamed: boolean; name: string }> {
    const name = config.jellyfinLibraryName;
    const folders = await api<VirtualFolder[]>('/Library/VirtualFolders');
    const existing = folders.find((f) => f.Locations.includes(libraryPath));

    const options = {
        Enabled: true,
        EnableRealtimeMonitor: true,
        // denpa が書いた .nfo を読み、Jellyfin 側からも .nfo に保存させる
        SaveLocalMetadata: true,
        MetadataSavers: ['Nfo'],
        // インターネットのメタデータ/画像取得は全部切る
        EnableInternetProviders: false,
        TypeOptions: ['Series', 'Season', 'Episode'].map((type) => ({
            Type: type,
            MetadataFetchers: [],
            MetadataFetcherOrder: [],
            ImageFetchers: [],
            ImageFetcherOrder: [],
        })),
        PathInfos: [{ Path: libraryPath }],
    };

    if (existing !== undefined) {
        // 既にあるなら作り直さず、設定だけ揃える
        await api<void>(`/Library/VirtualFolders/LibraryOptions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Id: existing.ItemId, LibraryOptions: options }),
        });
        // 名前を変えたくなったときのために、違っていたら付け替える
        let renamed = false;
        if (existing.Name !== name) {
            const rename = new URLSearchParams({ name: existing.Name, newName: name });
            await api<void>(`/Library/VirtualFolders/Name?${rename}`, { method: 'POST' });
            renamed = true;
        }
        return { created: false, renamed, name };
    }

    const query = new URLSearchParams({
        name,
        collectionType: 'tvshows',
        paths: libraryPath,
        refreshLibrary: 'true',
    });
    await api<void>(`/Library/VirtualFolders?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ LibraryOptions: options }),
    });
    return { created: true, renamed: false, name };
}

/**
 * 録画を Jellyfin の画面から消せるようにする。
 * 誰でも消せると事故るので、既定では管理者だけに付ける。
 */
export async function allowDeletion(everyone = false): Promise<string[]> {
    const users = await api<JellyfinUser[]>('/Users');
    const targets = users.filter((u) => everyone || u.Policy?.IsAdministrator === true);

    const granted: string[] = [];
    for (const user of targets) {
        if (user.Policy?.EnableContentDeletion === true) continue;
        await api<void>(`/Users/${user.Id}/Policy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...user.Policy, EnableContentDeletion: true }),
        });
        granted.push(user.Name);
    }
    return granted;
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
    // 失敗した録画を消したときに理由を上書きすると、なぜ失敗したのかが分からなくなる。
    // 元の理由があるならそちらを残す
    database()
        .prepare(
            `UPDATE recordings SET deleted_at = ?, library_path = NULL, ts_path = NULL,
             error = COALESCE(NULLIF(error, ''), ?), updated_at = ? WHERE id = ?`,
        )
        .run(now(), reason, now(), recording.id);
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
