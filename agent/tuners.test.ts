import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, TunerPool } from './tuners';

/**
 * チューナーの代わりに `sh` のコマンドを使う。取り合いのふるまいは
 * 実際に子プロセスを起こして確かめる — 殺し損ねはここでしか出ない。
 */

/** 止まらずに流し続けるコマンド。本物の選局と同じ形 */
const FOREVER = 'while :; do printf x; sleep 0.05; done';

function pool(...types: string[][]) {
    return new TunerPool(types.map((t, i) => ({ name: `adapter${i}`, types: t, command: FOREVER })));
}

/** 最初の1バイトが来るまで待つ。選局が始まったことの確認 */
async function firstByte(stream: ReadableStream<Uint8Array>): Promise<number> {
    const reader = stream.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return value?.byteLength ?? 0;
}

/** その文字列を含むプロセスの数。孫が残っていないかを見るのに使う */
function running(needle: string): number {
    let count = 0;
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            if (readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(needle)) count++;
        } catch {
            // 見ている間に終わったもの
        }
    }
    return count;
}

describe('チューナーコマンド', () => {
    test('mirakc のテンプレートを埋める', () => {
        expect(
            render('recisdb tune --device /dev/dvb/adapter0/frontend0 -c {{{channel}}} -', 'T27', 'GR'),
        ).toBe('recisdb tune --device /dev/dvb/adapter0/frontend0 -c T27 -');
    });

    test('種別と長さも埋める', () => {
        expect(render('x {{channel_type}} {{{duration}}}', 'T27', 'GR')).toBe('x GR -');
    });

    test('知らない差し込みは空にする', () => {
        expect(render('a {{{extra_args}}} b', 'T27', 'GR')).toBe('a  b');
    });
});

describe('取り合い', () => {
    test('種別に対応するチューナーが無ければ掴めない', () => {
        const tuners = pool(['GR']);
        expect(() => tuners.open({ type: 'BS', channel: 'BS01_0', priority: 1, use: 'x' })).toThrow(
            'BS のチューナーに空きがありません',
        );
        tuners.closeAll();
    });

    test('空いているチューナーを順に使う', async () => {
        const tuners = pool(['GR'], ['GR']);
        tuners.open({ type: 'GR', channel: 'T21', priority: 1, use: 'a' });
        tuners.open({ type: 'GR', channel: 'T22', priority: 1, use: 'b' });
        const status = tuners.status();
        expect(status[0].channel?.channel).toBe('T21');
        expect(status[1].channel?.channel).toBe('T22');
        tuners.closeAll();
    });

    /**
     * **ここが mirakc から引き取りたかったところ。** 番組表・ロゴ・録画が
     * 同じ物理チャンネルなら、選局は1本で足りる
     */
    test('同じチャンネルなら相乗りする。チューナーは増えない', async () => {
        const tuners = pool(['GR'], ['GR']);
        const a = tuners.open({ type: 'GR', channel: 'T21', priority: 1, use: 'rec 1' });
        const b = tuners.open({ type: 'GR', channel: 'T21', priority: 3, use: 'epg' });
        expect(await firstByte(a)).toBeGreaterThan(0);
        expect(await firstByte(b)).toBeGreaterThan(0);

        const status = tuners.status();
        expect(status[0].users.map((u) => u.use)).toEqual(['rec 1', 'epg']);
        expect(status[1].channel).toBeNull();
        tuners.closeAll();
    });

    test('空きが無ければ、自分より弱い相手を蹴る', async () => {
        const tuners = pool(['GR']);
        const weak = tuners.open({ type: 'GR', channel: 'T21', priority: 1, use: 'logo' });
        // 蹴られた側は「終わった」ではなく「失敗した」として伝わる。
        // 黙って閉じると、録画は空のファイルを「録れた」と扱ってしまう
        const reason = weak
            .getReader()
            .read()
            .then(() => null)
            .catch((error: unknown) => String(error));

        tuners.open({ type: 'GR', channel: 'T22', priority: 10, use: 'rec 1' });
        expect(tuners.status()[0].channel?.channel).toBe('T22');
        expect(await reason).toContain('優先度の高い要求に譲りました');
        tuners.closeAll();
    });

    test('自分より強い相手しか居なければ掴めない', () => {
        const tuners = pool(['GR']);
        tuners.open({ type: 'GR', channel: 'T21', priority: 10, use: 'rec 1' });
        expect(() => tuners.open({ type: 'GR', channel: 'T22', priority: 3, use: 'epg' })).toThrow();
        tuners.closeAll();
    });

    test('相乗りしている中でいちばん強い人が、そのチューナーの強さになる', () => {
        const tuners = pool(['GR']);
        tuners.open({ type: 'GR', channel: 'T21', priority: 1, use: 'logo' });
        tuners.open({ type: 'GR', channel: 'T21', priority: 10, use: 'rec 1' });
        // 弱いほうだけを見て蹴られると、相乗りしている録画まで巻き添えになる
        expect(() => tuners.open({ type: 'GR', channel: 'T22', priority: 5, use: 'scan' })).toThrow();
        tuners.closeAll();
    });

    test('止めると孫プロセスも残さない', async () => {
        const hold = join(mkdtempSync(join(tmpdir(), 'denpa-hold-')), 'hold.sh');
        writeFileSync(hold, 'while :; do sleep 1; done\n');
        const tuners = new TunerPool([{ name: 'a', types: ['GR'], command: `sh ${hold} | cat` }]);
        tuners.open({ type: 'GR', channel: 'T21', priority: 1, use: 'x' });
        await Bun.sleep(200);
        expect(running(hold)).toBeGreaterThan(0);

        tuners.closeAll();
        await Bun.sleep(500);
        // sh を1つ殺すだけでは残る。プロセスグループごと落とさないとデバイスが空かない
        expect(running(hold)).toBe(0);
    });

    test('無効にしたチューナーは使わない', () => {
        const tuners = new TunerPool([{ name: 'a', types: ['GR'], command: FOREVER, disabled: true }]);
        expect(() => tuners.open({ type: 'GR', channel: 'T21', priority: 1, use: 'x' })).toThrow();
        tuners.closeAll();
    });

    test('選局が落ちたら、読んでいる人には失敗として伝わる', async () => {
        const tuners = new TunerPool([
            { name: 'a', types: ['GR'], command: 'echo "Cannot open device" >&2; exit 1' },
        ]);
        const stream = tuners.open({ type: 'GR', channel: 'T21', priority: 1, use: 'x' });
        // 黙って終わると空のファイルが出来て「録れた」ことになる
        await expect(stream.getReader().read()).rejects.toThrow('Cannot open device');
        tuners.closeAll();
    });
});
