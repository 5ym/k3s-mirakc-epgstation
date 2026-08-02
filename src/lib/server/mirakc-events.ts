import { config } from './config';

/**
 * mirakc が起きたことを教えてくれる口 (`GET /events`, SSE)。
 *
 * **`/api` の下ではなく root にある。** OpenAPI (`/api/docs`) は `/api` 配下しか
 * 載せないので、そこだけ見て「イベント配信は無い」と判断すると取りこぼす。
 *
 * これが使えると、番組表の取り直しも放送の延長も「10分ごと」「30秒ごと」に
 * 覗きに行かずに済む。定期実行は**通知が途切れたときの保険**として残してある
 * (つなぎ直しは下でやっているが、黙って止まる可能性は消せない)。
 *
 * 実際に流れてくるもの (mirakc 3.4.79 のバイナリから拾った名前):
 *
 * | イベント | 中身 | denpa の使い道 |
 * | --- | --- | --- |
 * | `epg.programs-updated` | `{serviceId}` | 番組表を取り直す |
 * | `onair.program-changed` | `{serviceId}` | 録画中の終了時刻を読み直す |
 * | `tuner.status-changed` | `{tunerIndex}` | チューナー画面を更新する |
 * | `recording.*` `timeshift.*` | — | mirakc 自身の録画機能。denpa は使わない |
 */

export interface MirakcEvent {
    name: string;
    data: Record<string, unknown>;
}

/** つなぎ直しの待ち。すぐ繋ぎ直すと、mirakc が落ちている間に叩き続けることになる */
const RETRY_MIN = 1000;
const RETRY_MAX = 60_000;

/** SSE の1ブロックを解釈する。`event:` と `data:` だけ見れば足りる */
export function parseBlock(block: string): MirakcEvent | null {
    let name = '';
    let data = '';
    for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (name === '') return null;
    try {
        return { name, data: data === '' ? {} : (JSON.parse(data) as Record<string, unknown>) };
    } catch {
        return { name, data: {} };
    }
}

/**
 * 流れてきたバイト列をブロックに割る。
 * SSE の区切りは空行なので、途中で切れた分は次のチャンクまで持ち越す。
 */
export async function* blocks(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    // @ts-expect-error bun/node のストリームは非同期反復できる
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let at = buffer.indexOf('\n\n');
        while (at !== -1) {
            yield buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf('\n\n');
        }
    }
}

/**
 * 繋ぎっぱなしにして、届いたものを渡す。切れたら間を置いて繋ぎ直す。
 * 戻り値を呼ぶと止まる。
 */
export function listen(onEvent: (event: MirakcEvent) => void): () => void {
    let stopped = false;
    const controller = new AbortController();
    let retry = RETRY_MIN;

    const loop = async () => {
        while (!stopped) {
            try {
                const res = await fetch(`${config.mirakcUrl}/events`, {
                    signal: controller.signal,
                    headers: { Accept: 'text/event-stream' },
                });
                if (!res.ok || res.body === null) throw new Error(`/events -> ${res.status}`);

                // 繋がった時点で待ち時間を戻す。長く繋がっていたのに1度切れただけで
                // 1分待つ、ということにならないように
                retry = RETRY_MIN;
                console.log('[mirakc] イベントの購読を開始しました');

                for await (const block of blocks(res.body)) {
                    const event = parseBlock(block);
                    if (event !== null) onEvent(event);
                }
                if (!stopped) console.warn('[mirakc] イベントが途切れました。繋ぎ直します');
            } catch (error) {
                if (stopped) return;
                console.warn(
                    `[mirakc] イベントに繋げません (${Math.round(retry / 1000)}秒後に再試行): ${error}`,
                );
            }
            if (stopped) return;
            await new Promise((resolve) => setTimeout(resolve, retry));
            retry = Math.min(retry * 2, RETRY_MAX);
        }
    };

    void loop();

    return () => {
        stopped = true;
        controller.abort();
    };
}
