import type { CmMode, VideoCodec } from '../types';
import { isCmMode } from './cm';
import { config } from './config';
import { database, now, queryOne } from './db';
import { isVideoCodec } from './encoder';

/**
 * 画面から変えられる設定。
 *
 * コーデックとCMの扱いは、番組ごとに変えたくなることが実際にはほとんど無い。
 * ルールにも予約にも同じ選択肢を並べると、どこで決まったのか分からなくなるので
 * 全体で1つに寄せてある。環境変数は初期値として扱い、DBに値があればそちらが勝つ。
 */

export interface Settings {
    /** 録画のエンコードに使う映像コーデック */
    codec: VideoCodec;
    /** CMの扱い。off / chapter / cut */
    cmCut: CmMode;
    /** エンコードするか。しないなら生TSのまま置く */
    encode: boolean;
    /** エンコードしたあとも生TSを残すか */
    keepOriginal: boolean;
    /** 自動予約で無料放送だけを対象にするか */
    freeOnly: boolean;
    /**
     * 60コマ/秒で出すか。
     *
     * 放送は1080i (毎秒60フィールド) なので、フィールドごとに1コマ作れば
     * 動きは滑らかになる。ただし**コマ数が倍**で、エンコードの時間もサイズも約2倍。
     * 実測 (地上波1分・AV1): 31.8秒 26MB ↔ 切ったときは 16.9秒 15MB
     */
    smoothMotion: boolean;
    /**
     * CM検出のしかた。
     * jls     : ロゴが消えるかどうかまで見る。確かだが録画1本あたり数分かかる
     * silence : 無音とCM尺だけ。速いが本編の「間」を拾うことがある
     */
    cmDetector: 'jls' | 'silence';
    /** ベーシック認証。両方入っているときだけ有効 */
    basicAuthUser: string;
    basicAuthPassword: string;
    /** 認証をかける範囲。files … 配信とWebDAVだけ / all … 画面も含めて全部 */
    basicAuthScope: 'files' | 'all';
}

function stored(key: string): string | undefined {
    return queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}

export function settings(): Settings {
    const codec = stored('codec');
    const cmCut = stored('cmCut');
    const scope = stored('basicAuthScope') ?? config.basicAuthScope;
    const flag = (key: string, fallback: boolean) => {
        const value = stored(key);
        return value === undefined ? fallback : value === 'true';
    };
    return {
        codec: isVideoCodec(codec) ? codec : config.encodeCodec,
        cmCut: isCmMode(cmCut) ? cmCut : config.cmCutDefault,
        encode: flag('encode', true),
        keepOriginal: flag('keepOriginal', false),
        freeOnly: flag('freeOnly', true),
        smoothMotion: flag('smoothMotion', false),
        cmDetector: stored('cmDetector') === 'silence' ? 'silence' : 'jls',
        basicAuthUser: stored('basicAuthUser') ?? config.basicAuthUser,
        basicAuthPassword: stored('basicAuthPassword') ?? config.basicAuthPassword,
        basicAuthScope: scope === 'all' ? 'all' : 'files',
    };
}

export function saveSettings(patch: Partial<Settings>): Settings {
    const upsert = database().prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const at = now();
    const tx = database().transaction(() => {
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            upsert.run(key, String(value), at);
        }
    });
    tx();
    return settings();
}

/** その設定が環境変数のままなのか、画面で変えたものなのか */
export function isStored(key: keyof Settings): boolean {
    return stored(key) !== undefined;
}
