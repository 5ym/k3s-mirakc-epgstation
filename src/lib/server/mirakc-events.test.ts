import { describe, expect, test } from 'bun:test';
import { blocks, parseBlock } from './mirakc-events';

describe('mirakc の知らせ', () => {
    test('event と data を取り出す', () => {
        expect(parseBlock('event: epg.programs-updated\ndata: {"serviceId":3274201073}')).toEqual({
            name: 'epg.programs-updated',
            data: { serviceId: 3274201073 },
        });
    });

    test('data が無くても名前だけで通す', () => {
        expect(parseBlock('event: tuner.status-changed')).toEqual({
            name: 'tuner.status-changed',
            data: {},
        });
    });

    test('data が壊れていても名前は活かす', () => {
        // 知らない形が来ても、聞くのをやめてしまうより名前だけでも拾うほうがいい
        expect(parseBlock('event: epg.programs-updated\ndata: {壊れている')).toEqual({
            name: 'epg.programs-updated',
            data: {},
        });
    });

    test('コメントや心拍だけのブロックは捨てる', () => {
        expect(parseBlock(':heartbeat')).toBeNull();
        expect(parseBlock('data: {"a":1}')).toBeNull();
    });

    function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
            start(controller) {
                for (const part of parts) controller.enqueue(encoder.encode(part));
                controller.close();
            },
        });
    }

    test('空行で区切って渡す', async () => {
        const got: string[] = [];
        for await (const block of blocks(streamOf('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')))
            got.push(block);
        expect(got).toEqual(['event: a\ndata: 1', 'event: b\ndata: 2']);
    });

    test('途中で切れたブロックは次の分と繋ぐ', async () => {
        // TCP の切れ目はイベントの切れ目と関係が無い。持ち越さないと1件落ちる
        const got: string[] = [];
        for await (const block of blocks(streamOf('event: epg.pro', 'grams-updated\ndata: {}\n\n')))
            got.push(block);
        expect(got).toEqual(['event: epg.programs-updated\ndata: {}']);
    });

    test('区切りの来ていない残りは渡さない', async () => {
        const got: string[] = [];
        for await (const block of blocks(streamOf('event: a\ndata: 1'))) got.push(block);
        expect(got).toEqual([]);
    });
});
