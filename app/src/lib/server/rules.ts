import type { Program, Rule } from '../types';
import { db, now } from './db';
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

export function matches(rule: Rule, program: Program): boolean {
    if (rule.free_only && !program.is_free) return false;

    const services = parseList(rule.service_ids);
    if (services !== null && !services.includes(program.service_id)) return false;

    const genres = parseList(rule.genres);
    if (genres !== null) {
        const programGenres = parseList(program.genres);
        if (programGenres === null) return false;
        if (!programGenres.some((g) => genres.includes(g))) return false;
    }

    const text = haystack(program);

    // キーワードは空白区切りの AND。「アニメ 再放送」で両方含むものだけ拾える
    const keywords = toHalfWidth(rule.keyword).toLowerCase().split(/\s+/).filter(Boolean);
    if (!keywords.every((k) => text.includes(k))) return false;

    // 除外キーワードは OR。1つでも当たれば落とす
    const ignores = toHalfWidth(rule.ignore_keyword).toLowerCase().split(/\s+/).filter(Boolean);
    if (ignores.some((k) => text.includes(k))) return false;

    // 全条件が空のルールは全番組にマッチしてしまうので無効扱いにする
    return keywords.length > 0 || services !== null || genres !== null;
}

/**
 * 有効なルールを未来の番組に当てて予約を作る。
 * 既に予約がある番組は UNIQUE(program_id) で弾かれるので、手動予約やユーザーが
 * キャンセルした予約をルールが勝手に作り直すことはない。
 */
export function applyRules(): number {
    const rules = db.prepare('SELECT * FROM rules WHERE enabled = 1').all() as Rule[];
    if (rules.length === 0) return 0;

    const at = now();
    const programs = db
        .prepare('SELECT * FROM programs WHERE start_at > ? ORDER BY start_at')
        .all(at) as Program[];

    const insert = db.prepare(`
        INSERT OR IGNORE INTO reservations
            (program_id, rule_id, service_id, name, description, start_at, end_at,
             priority, manual, encode, keep_original, cm_cut, codec, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'scheduled', ?, ?)
    `);

    let created = 0;
    const tx = db.transaction(() => {
        for (const program of programs) {
            for (const rule of rules) {
                if (!matches(rule, program)) continue;
                const res = insert.run(
                    program.id,
                    rule.id,
                    program.service_id,
                    program.name,
                    program.description,
                    program.start_at,
                    program.end_at,
                    rule.priority,
                    rule.encode,
                    rule.keep_original,
                    rule.cm_cut,
                    rule.codec,
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
