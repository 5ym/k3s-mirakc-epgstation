import { describe, expect, test } from 'bun:test';
import type { Program, Rule } from '../types';
import { matches } from './rules';

/**
 * ルールの判定。DBには触らない (matches は純粋関数にしてある)。
 *
 * 見るのは主に「キーワードをどこに当てるか」。ここを広げすぎると
 * 番宣で名前が出ただけの番組まで録れてしまい、狭すぎると出演者で拾えない。
 */

function rule(fields: Partial<Rule>): Rule {
    return {
        id: 1,
        name: 'テスト',
        keyword: '',
        ignore_keyword: '',
        search_fields: 'name',
        service_ids: null,
        service_types: null,
        genres: null,
        free_only: 1,
        enabled: 1,
        priority: 2,
        encode: 1,
        keep_original: 0,
        cm_cut: 'chapter',
        codec: 'av1',
        source: null,
        created_at: 0,
        ...fields,
    };
}

function program(fields: Partial<Program>): Program {
    return {
        id: 1,
        service_id: 1,
        network_id: 1,
        event_id: 1,
        start_at: 0,
        end_at: 0,
        name: '',
        description: '',
        extended: null,
        genres: null,
        genre_detail: null,
        is_free: 1,
        audio_type: null,
        audios: null,
        video_type: null,
        video_resolution: null,
        updated_at: 0,
        ...fields,
    } as Program;
}

const target = program({
    name: '青のオーケストラ',
    description: '第20話「超える」',
    extended: JSON.stringify({ 出演者: '山田太郎 鈴木花子', 音楽: 'だれか' }),
});

describe('キーワードを当てる範囲', () => {
    test('既定は番組名だけ', () => {
        expect(matches(rule({ keyword: '青のオーケストラ' }), target)).toBe(true);
        // 概要にしかない語では当たらない
        expect(matches(rule({ keyword: '超える' }), target)).toBe(false);
        expect(matches(rule({ keyword: '山田太郎' }), target)).toBe(false);
    });

    test('概要まで広げる', () => {
        const r = rule({ keyword: '超える', search_fields: 'name,description' });
        expect(matches(r, target)).toBe(true);
        expect(matches(rule({ ...r, keyword: '山田太郎' }), target)).toBe(false);
    });

    test('詳細まで広げると出演者で拾える', () => {
        const r = rule({ keyword: '山田太郎', search_fields: 'name,description,extended' });
        expect(matches(r, target)).toBe(true);
    });

    test('詳細は見出しも探せる', () => {
        expect(matches(rule({ keyword: '出演者', search_fields: 'extended' }), target)).toBe(true);
    });

    test('壊れた詳細は空として扱う', () => {
        const broken = program({ name: 'あ', extended: '{壊れている' });
        expect(matches(rule({ keyword: 'あ', search_fields: 'name,extended' }), broken)).toBe(true);
        expect(matches(rule({ keyword: 'い', search_fields: 'extended' }), broken)).toBe(false);
    });

    test('範囲が空なら番組名だけに戻す', () => {
        // 全番組に当たってしまうので、指定なしとは解釈しない
        expect(matches(rule({ keyword: '青のオーケストラ', search_fields: '' }), target)).toBe(true);
        expect(matches(rule({ keyword: '超える', search_fields: '' }), target)).toBe(false);
    });

    test('除外キーワードも同じ範囲で見る', () => {
        const wide = rule({ keyword: '青の', ignore_keyword: '山田太郎', search_fields: 'name,extended' });
        expect(matches(wide, target)).toBe(false);
        // 番組名だけなら出演者は見ないので落ちない
        expect(matches(rule({ ...wide, search_fields: 'name' }), target)).toBe(true);
    });

    test('空白区切りは全部含むもの', () => {
        const r = rule({ keyword: '青の 超える', search_fields: 'name,description' });
        expect(matches(r, target)).toBe(true);
        expect(matches(rule({ ...r, keyword: '青の 届かない' }), target)).toBe(false);
    });
});
