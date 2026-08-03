import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 局だけの取り込み。
 *
 * mirakc は局と番組表を**別々に持っている**。知らせが飛んでくるのは番組表のぶんだけ
 * (`epg.programs-updated`) で、局が揃ったことは教えてくれない。初回起動や
 * チャンネルスキャンの直後は「局は分かったが番組表はこれから」が数十分続くので、
 * 番組表を待たずに局だけ先に取り込めることを確かめる。
 *
 * 環境変数ではなく設定そのものを書き換えている (files.test.ts と同じ理由)。
 */
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-epg-')), 'denpa.db');

/** 何を取りに来たか。番組表を取りに行っていないことまで見る */
const asked: string[] = [];

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const path = new URL(request.url).pathname;
        asked.push(path);
        if (path === '/api/services') {
            return Response.json([
                {
                    id: 3239123608,
                    serviceId: 23608,
                    networkId: 32391,
                    name: 'ＴＯＫＹＯ　ＭＸ',
                    type: 1,
                    channel: { type: 'GR', channel: 'T16' },
                },
                // データ放送。映像が入っていないので取り込まない
                {
                    id: 3239100700,
                    serviceId: 700,
                    networkId: 32391,
                    name: 'ＭＸデータ１',
                    type: 192,
                    channel: { type: 'GR', channel: 'T16' },
                },
            ]);
        }
        return new Response('not found', { status: 404 });
    },
});
config.mirakcUrl = `http://127.0.0.1:${server.port}`;

const { database } = await import('./db');
const { syncServicesOnly } = await import('./epg');

describe('syncServicesOnly', () => {
    test('番組表を待たずに局だけ取り込む', async () => {
        expect(await syncServicesOnly()).toBe(1);

        const rows = database().query('SELECT id, name, type FROM services').all();
        // 全角英数は取り込むときに直す。他の画面と字面がずれると別の局に見える
        expect(rows).toEqual([{ id: 3239123608, name: 'TOKYO MX', type: 'GR' }]);

        // 番組表は取りに行っていないこと。ここが本題で、
        // 番組表ごと取っていた頃は mirakc が集め終わるまで局も出せなかった
        expect(asked).toEqual(['/api/services']);
        expect(database().query('SELECT COUNT(*) AS n FROM programs').get()).toEqual({ n: 0 });
    });

    test('何度呼んでも増えない', async () => {
        await syncServicesOnly();
        expect(database().query('SELECT COUNT(*) AS n FROM services').get()).toEqual({ n: 1 });
    });
});
