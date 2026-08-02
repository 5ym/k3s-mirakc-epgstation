/**
 * mirakc の config.yml を読み書きする。
 *
 * 書くときは `channels:` の段落だけを差し替え、他はテキストのまま残す。
 * 読んで書き直すとコメントが全部消えるし、フロー形式で1行に潰れて、
 * 手でチューナーを足すときに読めなくなる。
 */

import type { ChannelEntry, Tuner } from './scan';

/** 設定から使うところだけ。書き戻しはテキスト側でやるので読み取り専用 */
export interface Config {
    tuners?: Tuner[];
    channels?: ChannelEntry[];
}

export function parseConfig(text: string): Config {
    return (Bun.YAML.parse(text) as Config) ?? {};
}

/** チャンネル1件をブロック形式で書く */
function renderChannel(channel: ChannelEntry): string {
    const services = channel.services.length > 0 ? `\n      services: [${channel.services.join(', ')}]` : '';
    return `    - name: ${channel.name}\n      type: ${channel.type}\n      channel: ${channel.channel}${services}`;
}

export function renderChannels(channels: ChannelEntry[]): string {
    if (channels.length === 0) return 'channels: []\n';
    return `channels:\n${channels.map(renderChannel).join('\n')}\n`;
}

/**
 * `channels:` の段落だけ差し替える。
 *
 * 段落の終わりは「次に来る字下げ無しの行」で見る。YAML のブロックは
 * 字下げで入れ子を表すので、これで過不足なく切り出せる。
 */
export function replaceChannels(text: string, channels: ChannelEntry[]): string {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => /^channels\s*:/.test(line));
    const block = renderChannels(channels);

    // 元が持っていなければ末尾に足す
    if (start === -1) return `${text.replace(/\n*$/, '\n')}\n${block}`;

    let end = start + 1;
    while (end < lines.length) {
        const line = lines[end];
        // 空行とコメントは段落の一部として飛ばす。字下げのある行も中身
        if (line.trim() !== '' && !line.startsWith('#') && !/^\s/.test(line)) break;
        end++;
    }
    // 直後に続くコメントは次の項目のものなので、段落から外す
    let tail = end;
    while (tail > start + 1 && (lines[tail - 1].startsWith('#') || lines[tail - 1].trim() === '')) {
        tail--;
    }

    return [...lines.slice(0, start), ...block.split('\n').slice(0, -1), ...lines.slice(tail)].join('\n');
}
