import { describe, expect, test } from 'bun:test';
import { countFound, scanUrl } from './scan';

const BASE = 'http://mirakurun:40772';

describe('スキャンのURL', () => {
    test('種別と範囲を渡す', () => {
        const url = new URL(scanUrl(BASE, { type: 'GR', min: 13, max: 62 }));
        expect(url.pathname).toBe('/api/config/channels/scan');
        expect(url.searchParams.get('type')).toBe('GR');
        expect(url.searchParams.get('minCh')).toBe('13');
        expect(url.searchParams.get('maxCh')).toBe('62');
    });

    test('既定は既存の一覧を更新する形', () => {
        // 上書きにすると、スキャンできなかった局が消える
        expect(new URL(scanUrl(BASE, { type: 'GR' })).searchParams.get('refresh')).toBe('true');
    });

    test('範囲を省いたら Mirakurun の既定に任せる', () => {
        const url = new URL(scanUrl(BASE, { type: 'BS' }));
        expect(url.searchParams.has('minCh')).toBe(false);
        expect(url.searchParams.has('maxCh')).toBe(false);
    });

    test('recisdb に合わせてチャンネル名の形も渡す', () => {
        // recisdb は T13 / CS16 の形でないと選局できない
        const gr = new URL(scanUrl(BASE, { type: 'GR' }));
        expect(gr.searchParams.get('channelNameFormat')).toBe('T{ch}');
        const cs = new URL(scanUrl(BASE, { type: 'CS' }));
        expect(cs.searchParams.get('channelNameFormat')).toBe('CS{ch}');
    });

    test('BSは Mirakurun の既定の形のまま', () => {
        // BS は BS{ch00}_{subch} で、こちらから指定すると壊れる
        const url = new URL(scanUrl(BASE, { type: 'BS' }));
        expect(url.searchParams.has('channelNameFormat')).toBe(false);
    });
});

describe('見つかった数', () => {
    test('見つけた行だけ数える', () => {
        const log = [
            'Scanning GR ch T13 ...',
            'channel: `T13` found',
            'Scanning GR ch T14 ...',
            'no signal',
            'channel: `T15` found',
        ];
        expect(countFound(log)).toBe(2);
    });

    test('何も見つからなければ0', () => {
        expect(countFound(['Scanning ...', 'no signal'])).toBe(0);
    });
});
