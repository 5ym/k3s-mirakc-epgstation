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

/**
 * 流れてくるバイト列を行に割って返す。
 * ffmpeg の `-progress pipe:1` のように、終わるのを待たずに読みたいとき用。
 */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of chunks(stream)) {
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split('\n');
        // 最後の1つは途中かもしれないので持ち越す
        buffer = parts.pop() ?? '';
        for (const part of parts) yield part.trim();
    }
    if (buffer.trim() !== '') yield buffer.trim();
}
