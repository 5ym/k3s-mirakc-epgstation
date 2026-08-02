import { type Genre, genreMatches } from '$lib/arib';
import { parseSearchFields, type SearchField } from '../search';
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

/** 詳細は見出し付きの JSON。見出しごと繋いで、素のテキストとして探せるようにする */
function extendedText(json: string | null): string {
    if (json === null || json === '') return '';
    try {
        const value = JSON.parse(json) as Record<string, string>;
        return Object.entries(value)
            .map(([heading, body]) => `${heading} ${body}`)
            .join(' ');
    } catch {
        return '';
    }
}

/** 検索対象のテキスト */
export function haystack(
    program: Pick<Program, 'name' | 'description' | 'extended'>,
    fields: SearchField[],
): string {
    const parts = fields.map((field) =>
        field === 'extended' ? extendedText(program.extended) : program[field],
    );
    return toHalfWidth(parts.join(' ')).toLowerCase();
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
 * 判定に使う形にほどいたルール。
 *
 * ほどく作業 (JSON の読み出し、キーワードの分割、全角の直し) を**ルール1つにつき
 * 1回**にするために分けてある。以前は判定のたびにやっていて、実機では
 * 有効なルール 318 × これから放送される番組 25,608 = **810万回**それをやっていた。
 * ルールを1つ足すだけで十数秒待たされていたのはこれが理由。
 */
export interface CompiledRule {
    rule: Rule;
    services: number[] | null;
    types: string[] | null;
    genres: string[] | null;
    fields: SearchField[];
    keywords: string[];
    ignores: string[];
}

export function compile(rule: Rule): CompiledRule {
    return {
        rule,
        services: parseList(rule.service_ids),
        types: parseStrings(rule.service_types),
        genres: parseStrings(rule.genres),
        fields: parseSearchFields(rule.search_fields),
        // キーワードは空白区切りの AND。「アニメ 再放送」で両方含むものだけ拾える
        keywords: toHalfWidth(rule.keyword).toLowerCase().split(/\s+/).filter(Boolean),
        // 除外キーワードは OR。1つでも当たれば落とす
        ignores: toHalfWidth(rule.ignore_keyword).toLowerCase().split(/\s+/).filter(Boolean),
    };
}

/**
 * ほどいたルールに番組が当てはまるか。
 *
 * 検索用テキストは**関数で受け取る**。文字を作るのが一番高くつくので、
 * チャンネルやジャンルで落ちる番組にはそもそも作らせない。
 * 同じ番組に何本ものルールを当てるときは、呼ぶ側が作ったものを使い回せる。
 */
export function matchesCompiled(
    compiled: CompiledRule,
    program: Program,
    serviceType: string | undefined,
    freeOnly: boolean,
    textOf: (fields: SearchField[]) => string,
): boolean {
    if (freeOnly && !program.is_free) return false;

    const { services, types, genres, keywords, ignores } = compiled;

    // チャンネルの条件は「種別」と「個別チャンネル」のOR。
    // 「地上波全部 + BS11だけ」のような指定ができるようにするため
    if (services !== null || types !== null) {
        const byService = services?.includes(program.service_id) ?? false;
        const byType = serviceType !== undefined && (types?.includes(serviceType) ?? false);
        if (!byService && !byType) return false;
    }

    // ジャンルは "7"(大分類だけ)と "7-0"(中分類まで)の2通りで持つ。
    // 昔のルールは数値の配列だが、String() を通せばそのまま大分類として読める
    if (genres !== null) {
        const detail = parseGenreDetail(program);
        if (detail.length === 0) return false;
        if (!genreMatches(genres, detail)) return false;
    }

    // 全条件が空のルールは全番組にマッチしてしまうので無効扱いにする
    if (keywords.length === 0 && services === null && types === null && genres === null) return false;

    if (keywords.length === 0 && ignores.length === 0) return true;

    const text = textOf(compiled.fields);
    if (!keywords.every((k) => text.includes(k))) return false;
    return !ignores.some((k) => text.includes(k));
}

/**
 * ルールに番組が当てはまるか。1件だけ見るとき用。
 *
 * 有料放送を対象にするかは全体設定なので、呼ぶ側が渡す
 * (ここで設定を読むと純粋関数でなくなり、テストから条件を作れない)。
 */
export function matches(rule: Rule, program: Program, serviceType?: string, freeOnly = true): boolean {
    return matchesCompiled(compile(rule), program, serviceType, freeOnly, (fields) =>
        haystack(program, fields),
    );
}

/**
 * 番組1つぶんの検索用テキストを、対象範囲ごとに1度だけ作って使い回す。
 * ほとんどのルールは同じ範囲 (番組名だけ) を見るので、実際にはほぼ1回で済む。
 */
function textCache(program: Program): (fields: SearchField[]) => string {
    const cache = new Map<string, string>();
    return (fields) => {
        const key = fields.join(',');
        let text = cache.get(key);
        if (text === undefined) {
            text = haystack(program, fields);
            cache.set(key, text);
        }
        return text;
    };
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

    const compiled = rules.map(compile);

    let created = 0;
    const tx = database().transaction(() => {
        for (const program of programs) {
            const textOf = textCache(program);
            for (const candidate of compiled) {
                if (!matchesCompiled(candidate, program, program.service_type, recording.freeOnly, textOf))
                    continue;
                const rule = candidate.rule;
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
