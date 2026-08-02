import { type Genre, genreMatches } from '$lib/arib';
import type { Program, Rule } from '../types';
import { database, now, queryAll } from './db';
import { settings } from './settings';
import { toHalfWidth } from './title';

function parseList(json: string | null): number[] | null {
    if (json === null || json === '') return null;
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) && v.length > 0 ? v.map(Number) : null;
    } catch {
        return null;
    }
}

/** 検索対象のテキスト。番組名だけだと「ゲスト名で拾う」ができないので概要も含める */
function haystack(program: Pick<Program, 'name' | 'description'>): string {
    return toHalfWidth(`${program.name} ${program.description}`).toLowerCase();
}

/** JSON配列の文字列版。種別(GR/BS/CS)の絞り込みに使う */
/**
 * 番組のジャンル。中分類まで持っている genre_detail を使い、
 * 取り込みが古くて入っていないものは大分類だけの genres で代用する
 */
function parseGenreDetail(program: Program): Genre[] {
    const detail = parseStrings(program.genre_detail);
    if (detail !== null) {
        try {
            return JSON.parse(program.genre_detail!) as Genre[];
        } catch {
            // 壊れていれば下の大分類で見る
        }
    }
    return (parseList(program.genres) ?? []).map((lv1) => ({ lv1, lv2: -1 }));
}

function parseStrings(json: string | null): string[] | null {
    if (json === null || json === '') return null;
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) && v.length > 0 ? v.map(String) : null;
    } catch {
        return null;
    }
}

/**
 * ルールに番組が当てはまるか。
 *
 * 有料放送を対象にするかは全体設定なので、呼ぶ側が渡す
 * (ここで設定を読むと純粋関数でなくなり、テストから条件を作れない)。
 */
export function matches(rule: Rule, program: Program, serviceType?: string, freeOnly = true): boolean {
    if (freeOnly && !program.is_free) return false;

    // チャンネルの条件は「種別」と「個別チャンネル」のOR。
    // 「地上波全部 + BS11だけ」のような指定ができるようにするため
    const services = parseList(rule.service_ids);
    const types = parseStrings(rule.service_types);
    if (services !== null || types !== null) {
        const byService = services?.includes(program.service_id) ?? false;
        const byType = serviceType !== undefined && (types?.includes(serviceType) ?? false);
        if (!byService && !byType) return false;
    }

    // ジャンルは "7"(大分類だけ)と "7-0"(中分類まで)の2通りで持つ。
    // 昔のルールは数値の配列だが、String() を通せばそのまま大分類として読める
    const genres = parseStrings(rule.genres);
    if (genres !== null) {
        const detail = parseGenreDetail(program);
        if (detail.length === 0) return false;
        if (!genreMatches(genres, detail)) return false;
    }

    const text = haystack(program);

    // キーワードは空白区切りの AND。「アニメ 再放送」で両方含むものだけ拾える
    const keywords = toHalfWidth(rule.keyword).toLowerCase().split(/\s+/).filter(Boolean);
    if (!keywords.every((k) => text.includes(k))) return false;

    // 除外キーワードは OR。1つでも当たれば落とす
    const ignores = toHalfWidth(rule.ignore_keyword).toLowerCase().split(/\s+/).filter(Boolean);
    if (ignores.some((k) => text.includes(k))) return false;

    // 全条件が空のルールは全番組にマッチしてしまうので無効扱いにする
    return keywords.length > 0 || services !== null || types !== null || genres !== null;
}

/**
 * 有効なルールを未来の番組に当てて予約を作る。
 * 既に予約がある番組は UNIQUE(program_id) で弾かれるので、手動予約やユーザーが
 * キャンセルした予約をルールが勝手に作り直すことはない。
 */
export function applyRules(): number {
    const rules = database().prepare('SELECT * FROM rules WHERE enabled = 1').all() as Rule[];
    if (rules.length === 0) return 0;

    const at = now();
    // 録画のしかたは全体で1つ。ルールごとに持たせるとどこで決まったか分からなくなる
    const recording = settings();
    // 種別(GR/BS/CS)でも絞り込めるよう、番組にチャンネル種別を添えて取る
    const programs = queryAll<Program & { service_type: string }>(
        `SELECT p.*, s.type AS service_type FROM programs p
         JOIN services s ON s.id = p.service_id
         WHERE p.start_at > ? ORDER BY p.start_at`,
        at,
    );

    const insert = database().prepare(`
        INSERT OR IGNORE INTO reservations
            (program_id, rule_id, service_id, name, description, start_at, end_at,
             priority, manual, encode, keep_original, cm_cut, codec, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'scheduled', ?, ?)
    `);

    let created = 0;
    const tx = database().transaction(() => {
        for (const program of programs) {
            for (const rule of rules) {
                if (!matches(rule, program, program.service_type, recording.freeOnly)) continue;
                const res = insert.run(
                    program.id,
                    rule.id,
                    program.service_id,
                    program.name,
                    program.description,
                    program.start_at,
                    program.end_at,
                    rule.priority,
                    recording.encode ? 1 : 0,
                    recording.keepOriginal ? 1 : 0,
                    recording.cmCut,
                    recording.codec,
                    at,
                    at,
                );
                if (res.changes > 0) created++;
                // 同じ番組に複数ルールが当たっても予約は1つ。先勝ちで次の番組へ
                break;
            }
        }
    });
    tx();
    return created;
}
