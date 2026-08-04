import { type Genre, genreMatches } from '$lib/arib';
import { parseSearchFields, type SearchField } from '../search';
import type { Program, Rule } from '../types';
import { config } from './config';
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

export interface RuleSync {
    /** 新しく立てた予約 */
    created: number;
    /** どのルールにも当たらなくなって消した予約 */
    dropped: number;
    /** 別のルールが引き取った予約 */
    moved: number;
}

/**
 * ルールを取り込みたい予約。まだ立てていないものと、いま立っているものを突き合わせる。
 */
interface Held {
    id: number;
    program_id: number;
    rule_id: number | null;
    start_at: number;
}

/**
 * ルールを番組表に当て直して、予約をそろえる。
 *
 * **足すだけでなく、外れたものは消す。** 足すだけだった頃は、番組表が書き換わって
 * 条件から外れた予約がそのまま残り、消す手立てが画面の「取り消し」しか無かった。
 *
 * - 当たるのに予約が無い → **作る**
 * - 予約があるのに、どのルールにも当たらなくなった → **消す**
 * - 当てているルールが変わった (別のルールが引き取った) → **付け替える**
 *
 * **消すのであって「取り消し」にはしない。** 取り消しは*人が押したこと*の記録で、
 * ルールは二度と作り直さない (`INSERT OR IGNORE`)。番組表が動いただけのものを
 * 取り消しにすると、条件に戻ってきても永久に予約が立たなくなる。
 *
 * ### 引っ込めないもの
 *
 * 手違いで消すほうが、余分に録るより高くつく。次のどれかに当たるものは残す。
 *
 * - **手動の予約と、録り始めたもの** (`manual` / `started_at`)
 * - **人が取り消したもの。** 取り消しの記録はそのまま残す
 * - **番組表からその番組ごと消えているとき。** 「条件から外れた」のか
 *   「まだ読めていない」のか区別が付かない
 * - **題名が空の番組。** 放送が名前を出していないのではなく、こちらがまだ
 *   読めていないだけのことがある (実機で 23,000 件のうち 11,000 件がそうだった)
 * - **もうすぐ始まるもの** (`config.ruleRetractGrace`)。番組表は放送直前まで
 *   書き換わるので、そこで条件を外れても手遅れになるより録っておく。
 *   ただし**ルールごと消された/止められたぶんは、直前でも引っ込める** —
 *   そちらは人が押した結果なので迷う理由がない
 *
 * @param options.rule そのルールだけを当てる。**足すことしかしない。**
 *   ルールを足した直後用 — 新しいルールは他の予約を外すことができないので、
 *   全ルール × 全番組 (実機で 318 × 25,608) を回し直さずに済む
 */
export function applyRules(options: { rule?: number } = {}): RuleSync {
    const result: RuleSync = { created: 0, dropped: 0, moved: 0 };
    const rules = database().prepare('SELECT * FROM rules WHERE enabled = 1').all() as Rule[];
    const adding = options.rule !== undefined;
    if (rules.length === 0 && adding) return result;

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

    const compiled = rules.map(compile);
    const searching = adding ? compiled.filter((c) => c.rule.id === options.rule) : compiled;

    /** 番組 → 受け持つルール。同じ番組に何本当たっても予約は1つで、**先勝ち** */
    const wanted = new Map<number, { rule: Rule; program: Program }>();
    for (const program of programs) {
        const textOf = textCache(program);
        for (const candidate of searching) {
            if (!matchesCompiled(candidate, program, program.service_type, recording.freeOnly, textOf))
                continue;
            wanted.set(program.id, { rule: candidate.rule, program });
            break;
        }
    }

    const insert = database().prepare(`
        INSERT OR IGNORE INTO reservations
            (program_id, rule_id, service_id, name, description, start_at, end_at,
             priority, manual, encode, keep_original, cm_cut, codec, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'scheduled', ?, ?)
    `);
    const drop = database().prepare('DELETE FROM reservations WHERE id = ?');
    const move = database().prepare(
        'UPDATE reservations SET rule_id = ?, priority = ?, updated_at = ? WHERE id = ?',
    );

    /** いまルールが立てている予約。手動と、録り始めたものは入らない */
    const held = adding
        ? []
        : queryAll<Held>(
              `SELECT id, program_id, rule_id, start_at FROM reservations
                WHERE manual = 0 AND started_at IS NULL AND state IN ('scheduled', 'conflict')`,
          );
    /** 番組表にまだ載っている番組。読めていないだけのものと区別する */
    const listed = new Map(programs.map((program) => [program.id, program]));
    /** まだ生きているルール。消された/止められたぶんは猶予を置かずに引っ込める */
    const enabled = new Set(rules.map((rule) => rule.id));
    const grace = at + config.ruleRetractGrace;

    const tx = database().transaction(() => {
        for (const { rule, program } of wanted.values()) {
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
            if (res.changes > 0) result.created++;
        }

        for (const reservation of held) {
            const owner = wanted.get(reservation.program_id);
            if (owner !== undefined) {
                // 別のルールが引き取った。付け替えるだけで、録るものは変わらない
                if (owner.rule.id !== reservation.rule_id) {
                    move.run(owner.rule.id, owner.rule.priority, at, reservation.id);
                    result.moved++;
                }
                continue;
            }
            const program = listed.get(reservation.program_id);
            // 番組表から消えているだけかもしれない。題名が空のものも判断材料にならない
            if (program === undefined || program.name === '') continue;
            // ルールが生きているのに外れた = 番組表が動いた。直前なら録っておく
            const byChurn = reservation.rule_id !== null && enabled.has(reservation.rule_id);
            if (byChurn && reservation.start_at < grace) continue;
            drop.run(reservation.id);
            result.dropped++;
        }
    });
    tx();
    return result;
}
