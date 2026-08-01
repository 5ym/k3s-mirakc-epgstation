import { describe, expect, test } from 'bun:test';
import type { Recording } from '../types';
import { episodeNfo, sidecarPaths, tvshowNfo } from './metadata';

function recording(over: Partial<Recording> = {}): Recording {
    return {
        id: 42,
        reservation_id: 1,
        program_id: 1,
        service_id: 1,
        service_name: 'TOKYO MX',
        name: 'テストアニメ #12 決戦',
        series: 'テストアニメ',
        subtitle: '決戦',
        description: '主人公が敵と対決する',
        // 2026-08-01 21:30 JST 開始・30分 (テストは TZ=Asia/Tokyo 前提)
        start_at: new Date('2026-08-01T21:30:00+09:00').getTime(),
        end_at: new Date('2026-08-01T22:00:00+09:00').getTime(),
        audio_type: 1,
        ts_path: null,
        ts_size: 0,
        library_path: null,
        state: 'available',
        error: null,
        keep_original: 0,
        cm_cut: 'chapter',
        cm_ranges: null,
        deleted_at: null,
        created_at: 0,
        updated_at: 0,
        ...over,
    } as Recording;
}

describe('sidecarPaths', () => {
    test('拡張子を差し替えたパスになる', () => {
        const paths = sidecarPaths('/library/番組/Season 2026/番組 - 2026-08-01 - 2130.mkv');
        expect(paths.nfo).toBe('/library/番組/Season 2026/番組 - 2026-08-01 - 2130.nfo');
        expect(paths.thumbnail).toBe('/library/番組/Season 2026/番組 - 2026-08-01 - 2130-thumb.jpg');
    });
});

describe('episodeNfo', () => {
    test('放送日・尺・放送局が入る', () => {
        const nfo = episodeNfo(recording());
        expect(nfo).toContain('<aired>2026-08-01</aired>');
        expect(nfo).toContain('<premiered>2026-08-01</premiered>');
        expect(nfo).toContain('<runtime>30</runtime>');
        expect(nfo).toContain('<studio>TOKYO MX</studio>');
        expect(nfo).toContain('<showtitle>テストアニメ</showtitle>');
        expect(nfo).toContain('<plot>主人公が敵と対決する</plot>');
    });

    test('サブタイトルがあればそれをエピソード名にする', () => {
        expect(episodeNfo(recording())).toContain('<title>決戦</title>');
    });

    test('サブタイトルが無ければ番組名をそのまま使う', () => {
        const nfo = episodeNfo(recording({ subtitle: '', name: 'ニュース' }));
        expect(nfo).toContain('<title>ニュース</title>');
    });

    test('XMLで意味を持つ文字をエスケープする', () => {
        const nfo = episodeNfo(recording({ description: 'A&B <特番> "生放送"' }));
        expect(nfo).toContain('<plot>A&amp;B &lt;特番&gt; &quot;生放送&quot;</plot>');
        // エスケープ漏れがあると、NFO を読むプレイヤーがファイルごと読み飛ばす
        expect(nfo).not.toContain('<特番>');
    });

    test('再スキャンで別物にならないよう録画IDを持たせる', () => {
        expect(episodeNfo(recording())).toContain('>42</uniqueid>');
    });
});

describe('tvshowNfo', () => {
    test('シリーズ名を明示する', () => {
        expect(tvshowNfo(recording())).toContain('<title>テストアニメ</title>');
    });
});
