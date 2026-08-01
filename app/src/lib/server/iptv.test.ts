import { describe, expect, test } from 'bun:test';
import type { Program, Service } from '../types';
import { playlist, xmltv, xmltvTime } from './iptv';

const service = (over: Partial<Service> = {}): Service => ({
    id: 3239123608,
    service_id: 23608,
    network_id: 32391,
    name: 'TOKYO MX',
    type: 'GR',
    channel: 'T16',
    remote_control_key: 9,
    updated_at: 0,
    ...over,
});

const program = (over: Partial<Program> = {}): Program => ({
    id: 1,
    service_id: 3239123608,
    network_id: 32391,
    event_id: 1,
    start_at: new Date('2026-08-01T21:30:00+09:00').getTime(),
    end_at: new Date('2026-08-01T22:00:00+09:00').getTime(),
    name: 'テスト & 番組',
    description: '<概要>',
    extended: null,
    genres: null,
    is_free: 1,
    audio_type: 1,
    updated_at: 0,
    ...over,
});

describe('xmltvTime', () => {
    test('ローカル時刻とオフセットで書く (TZ=Asia/Tokyo 前提)', () => {
        expect(xmltvTime(new Date('2026-08-01T21:30:00+09:00').getTime())).toBe('20260801213000 +0900');
    });
});

describe('playlist', () => {
    test('各チャンネルが denpa の変換済みストリームを指す', () => {
        const m3u = playlist([service()], 'http://denpa:3000', 'h264');
        expect(m3u).toContain('#EXTM3U');
        expect(m3u).toContain('tvg-id="3239123608"');
        expect(m3u).toContain('group-title="GR"');
        // Mirakurun の生TSではなく denpa 側を向いていること
        expect(m3u).toContain('http://denpa:3000/api/live/3239123608/h264');
        expect(m3u).not.toContain('40772');
    });

    test('プロファイルがURLに反映される', () => {
        expect(playlist([service()], 'http://denpa:3000', 'av1')).toContain('/api/live/3239123608/av1');
    });

    test('チャンネルが無くてもヘッダだけは返る', () => {
        expect(playlist([], 'http://denpa:3000', 'h264').trim()).toBe('#EXTM3U');
    });
});

describe('xmltv', () => {
    test('チャンネルと番組が tvg-id で結びつく', () => {
        const doc = xmltv([service()], [program()]);
        expect(doc).toContain('<channel id="3239123608">');
        expect(doc).toContain('channel="3239123608"');
        expect(doc).toContain('start="20260801213000 +0900"');
        expect(doc).toContain('stop="20260801220000 +0900"');
    });

    test('XMLで意味を持つ文字をエスケープする', () => {
        const doc = xmltv([service()], [program()]);
        expect(doc).toContain('<title lang="ja">テスト &amp; 番組</title>');
        expect(doc).toContain('<desc lang="ja">&lt;概要&gt;</desc>');
    });

    test('概要が空なら desc を出さない', () => {
        expect(xmltv([service()], [program({ description: '' })])).not.toContain('<desc');
    });
});
