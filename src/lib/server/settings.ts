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
    /** 録画のエンコードに使う映像コーデック。`none` ならエンコードしない */
    codec: VideoCodec;
    /** CMの扱い。off / chapter / cut */
    cmCut: CmMode;
    /**
     * エンコードするか。**コーデックの選択から決まる** (`none` 以外なら する)。
     * 別のチェックとして持っていた頃は、外したときにコーデックの選択だけが残り、
     * どちらが効いているのか画面から読めなかった
     */
    encode: boolean;
    /** エンコードしたあとも生TSを残すか */
    keepOriginal: boolean;
    /** 自動予約で無料放送だけを対象にするか */
    freeOnly: boolean;
    /**
     * CM検出のしかた。
     * jls     : ロゴが消えるかどうかまで見る。確かだが録画1本あたり数分かかる
     * silence : 無音とCM尺だけ。速いが本編の「間」を拾うことがある
     */
    cmDetector: 'jls' | 'silence';
    /**
     * **ロゴをどれだけ当てにするか** (1〜8、既定 6)。
     *
     * join_logo_scp は無音・シーンチェンジと「ロゴが出ているか」を突き合わせて
     * 番組の構成を推測する。その推測でロゴ情報をどれだけ優先するかがこれ
     * (JL の `logo_level`)。ロゴが正しいのにCMを取り違えるなら上げる、
     * ロゴを覚え違えているようなら下げる。1 でロゴを使わなくなる
     */
    logoLevel: number;
    /** ベーシック認証。両方入っているときだけ有効 */
    basicAuthUser: string;
    basicAuthPassword: string;
    /** 認証をかける範囲。files … 配信とWebDAVだけ / all … 画面も含めて全部 */
    basicAuthScope: 'files' | 'all';
}

/** JL の logo_level。範囲の外は既定に倒す (規則ファイルに書き込む値なので) */
function logoLevel(value: string | undefined): number {
    const level = Number(value);
    return Number.isInteger(level) && level >= 1 && level <= 8 ? level : config.jlsLogoLevel;
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
    /*
     * 「エンコードする」のチェックを持っていた頃のDBは、そこに false が入っている。
     * コーデックの選択に寄せたので、それを `none` として読む
     */
    const chosen = isVideoCodec(codec) ? codec : config.encodeCodec;
    const resolved = flag('encode', true) ? chosen : 'none';
    return {
        codec: resolved,
        cmCut: isCmMode(cmCut) ? cmCut : config.cmCutDefault,
        encode: resolved !== 'none',
        keepOriginal: flag('keepOriginal', false),
        freeOnly: flag('freeOnly', true),
        cmDetector: stored('cmDetector') === 'silence' ? 'silence' : 'jls',
        logoLevel: logoLevel(stored('logoLevel')),
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
