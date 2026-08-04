import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ルールを番組表に当て直して、予約をそろえるところ。
 *
 * **足すだけではない。** 番組表は放送直前まで書き換わるので、条件から外れた予約を
 * 引っ込めるところまで含めて1つの動き。ただし手違いで消すほうが余分に録るより
 * 高くつくので、迷う場面では残す。その線引きをここで見る。
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-rules-')), 'denpa.db');

const { database, now } = await import('./db');
const { applyRules } = await import('./rules');

const SERVICE = 3239123608;
const HOUR = 60 * 60 * 1000;

const CLEAR = 'DELETE FROM reservations; DELETE FROM programs; DELETE FROM rules; DELETE FROM services';

/*
 * **置いたものは持って帰る。** bun test はファイルをまたいでモジュールを使い回すので、
 * DBの接続も1つ (`db.database`)。先に開いたファイルの置き場が全員のものになるため、
 * 行を残すと隣のファイルの「まだ空のはず」が崩れる (実機ならぬCIで epg.test.ts が落ちた)
 */
afterAll(() => database().exec(CLEAR));

function reset(): void {
    const db = database();
    db.exec(CLEAR);
    db.prepare(
        `INSERT INTO services (id, service_id, network_id, name, type, service_type, channel, has_logo, updated_at)
         VALUES (?, 23608, 32391, 'TOKYO MX1', 'GR', 1, 'T16', 0, ?)`,
    ).run(SERVICE, now());
}

/** 番組を1つ置く。既定は3時間後から (猶予の外) */
function program(id: number, name: string, startsIn = 3 * HOUR): void {
    const start = now() + startsIn;
    database()
        .prepare(
            `INSERT OR REPLACE INTO programs
                (id, service_id, network_id, event_id, start_at, end_at, name, description, is_free, updated_at)
             VALUES (?, ?, 32391, ?, ?, ?, ?, '', 1, ?)`,
        )
        .run(id, SERVICE, id, start, start + HOUR, name, now());
}

function rule(id: number, keyword: string, enabled = 1): void {
    database()
        .prepare(
            `INSERT OR REPLACE INTO rules
                (id, name, keyword, ignore_keyword, search_fields, service_ids, service_types,
                 genres, enabled, priority, created_at)
             VALUES (?, ?, ?, '', 'name', NULL, NULL, NULL, ?, 1, ?)`,
        )
        .run(id, keyword, keyword, enabled, now());
}

const reservations = () =>
    database()
        .query<{ program_id: number; rule_id: number | null; state: string }, []>(
            'SELECT program_id, rule_id, state FROM reservations ORDER BY program_id',
        )
        .all();

describe('ルールを当て直す', () => {
    test('当たる番組に予約が立つ', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6');
        program(11, 'まったく別の番組');

        expect(applyRules()).toEqual({ created: 1, dropped: 0, moved: 0 });
        expect(reservations()).toEqual([{ program_id: 10, rule_id: 1, state: 'scheduled' }]);
    });

    /*
     * **取り消しではなく削除。** 取り消しは*人が押したこと*の記録で、ルールは
     * 二度と作り直さない (INSERT OR IGNORE)。番組表が動いただけのものを取り消しに
     * すると、条件に戻ってきても永久に予約が立たなくなる
     */
    test('条件から外れた予約は消す。取り消しにはしない', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6');
        applyRules();

        // 番組表が書き換わって、名前が変わった
        program(10, '(番組の差し替え) 特別番組');

        expect(applyRules()).toMatchObject({ dropped: 1 });
        expect(reservations()).toEqual([]);
    });

    test('人が取り消した予約は作り直さない', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6');
        applyRules();
        database().prepare("UPDATE reservations SET state = 'canceled' WHERE program_id = 10").run();

        expect(applyRules()).toMatchObject({ created: 0, dropped: 0 });
        expect(reservations()).toEqual([{ program_id: 10, rule_id: 1, state: 'canceled' }]);
    });

    test('手動の予約は触らない', () => {
        reset();
        program(10, '手で入れた番組');
        database()
            .prepare(
                `INSERT INTO reservations (program_id, rule_id, service_id, name, description,
                    start_at, end_at, manual, state, created_at, updated_at)
                 VALUES (10, NULL, ?, '手で入れた番組', '', ?, ?, 1, 'scheduled', ?, ?)`,
            )
            .run(SERVICE, now() + 3 * HOUR, now() + 4 * HOUR, now(), now());

        expect(applyRules()).toMatchObject({ dropped: 0 });
        expect(reservations()).toHaveLength(1);
    });

    test('録り始めた予約は触らない', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6');
        applyRules();
        database().prepare('UPDATE reservations SET started_at = ? WHERE program_id = 10').run(now());
        program(10, '差し替え');

        expect(applyRules()).toMatchObject({ dropped: 0 });
        expect(reservations()).toHaveLength(1);
    });

    /*
     * 番組が消えているのは「条件から外れた」のか「まだ読めていない」のか
     * 区別が付かない。実機では番組表の取り込みが1チャンネルずつなので、
     * 途中の状態を何度も見ることになる
     */
    test('番組表からその番組ごと消えているだけなら残す', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6');
        applyRules();
        database().prepare('DELETE FROM programs WHERE id = 10').run();

        expect(applyRules()).toMatchObject({ dropped: 0 });
        expect(reservations()).toHaveLength(1);
    });

    /*
     * 番組表は基本 (題名) と詳細 (番組内容) の2つの表に分かれて流れてくる。
     * 詳細しか読めていない番組は題名が空で、キーワードには当たりようがない。
     * 実機では 23,000 件のうち 11,000 件がこの状態だった
     */
    test('題名が空の番組では判断しない', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6');
        applyRules();
        program(10, '');

        expect(applyRules()).toMatchObject({ dropped: 0 });
        expect(reservations()).toHaveLength(1);
    });

    test('もうすぐ始まるものは、条件から外れても引っ込めない', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6', 10 * 60 * 1000);
        applyRules();
        // 放送直前の書き換えで条件から外れた
        program(10, '急な差し替え', 10 * 60 * 1000);

        expect(applyRules()).toMatchObject({ dropped: 0 });
        expect(reservations()).toHaveLength(1);
    });

    test('ルールを止めたぶんは、直前でも引っ込める', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6', 10 * 60 * 1000);
        applyRules();
        rule(1, '無職転生', 0);

        expect(applyRules()).toMatchObject({ dropped: 1 });
        expect(reservations()).toEqual([]);
    });

    test('別のルールが引き取ったら付け替える', () => {
        reset();
        rule(1, '無職転生');
        rule(2, 'Ⅲ');
        program(10, '無職転生Ⅲ #6');
        applyRules();
        expect(reservations()).toEqual([{ program_id: 10, rule_id: 1, state: 'scheduled' }]);

        // 1 を消した。2 がまだ当たるので、予約は生き続ける
        database().prepare('DELETE FROM rules WHERE id = 1').run();

        expect(applyRules()).toMatchObject({ dropped: 0, moved: 1 });
        expect(reservations()).toEqual([{ program_id: 10, rule_id: 2, state: 'scheduled' }]);
    });

    test('引き取り手が無ければ消える', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6');
        applyRules();
        database().prepare('DELETE FROM rules WHERE id = 1').run();

        expect(applyRules()).toMatchObject({ dropped: 1 });
        expect(reservations()).toEqual([]);
    });

    /*
     * 足したばかりのルールは他の予約を外せないので、範囲を絞れる。
     * 実機ではルール 318 本 × これから放送される番組 25,608 件を回すことになる
     */
    test('ルールを1本だけ当てるときは、足すだけで消さない', () => {
        reset();
        rule(1, '無職転生');
        program(10, '無職転生Ⅲ #6');
        program(11, 'さよならララ #6');
        applyRules();

        // 2 を足した。1 の予約には触らない (このとき 1 は当てにも行かない)
        rule(2, 'さよならララ');

        expect(applyRules({ rule: 2 })).toEqual({ created: 1, dropped: 0, moved: 0 });
        expect(reservations()).toEqual([
            { program_id: 10, rule_id: 1, state: 'scheduled' },
            { program_id: 11, rule_id: 2, state: 'scheduled' },
        ]);
    });
});
