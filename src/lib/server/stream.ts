/**
 * ReadableStream を1チャンクずつ読む。
 *
 * Bun の ReadableStream は実際には for-await できるが、TypeScript の DOM 型定義には
 * Symbol.asyncIterator が無く型エラーになる。reader を明示的に回すことで型を通しつつ、
 * abort 時に read() が reject する挙動もそのまま使える。
 */
export async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value !== undefined) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

/** ストリームを最後まで読んで文字列にする */
export async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let out = '';
    for await (const chunk of chunks(stream)) out += decoder.decode(chunk, { stream: true });
    return out + decoder.decode();
}
