import type { Program, Service } from '../types';

/**
 * denpa 自身を IPTV のチューナーとして見せるための M3U / XMLTV。
 *
 * Mirakurun の `/api/iptv/*` をそのまま Jellyfin に渡すと、Jellyfin は MPEG-2 を
 * 受け取って実時間トランスコードすることになり、その中身をこちらから指定できない。
 * 代わりに denpa の `/api/live/{id}/ts`(H.264 + AAC に変換済み)を指すプレイリストを
 * 配れば、Jellyfin 側はリマックスするだけで済み、エンコード設定はこちらが握れる。
 *
 * 番組表も Mirakurun のものではなく denpa のDBから作る。全角の正規化などが
 * 済んでいて、denpa の番組表と食い違わないため。
 */

function xml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** XMLTV の時刻表記 `YYYYMMDDHHMMSS +0900`。ローカル時刻とオフセットで書く */
export function xmltvTime(ms: number): string {
    const d = new Date(ms);
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const stamp =
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `${stamp} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/**
 * M3U プレイリスト。`origin` は Jellyfin から見た denpa のURL。
 * Jellyfin はここに書かれたURLをそのまま開くので、コンテナ間で解決できる形にする。
 */
export function playlist(services: Service[], origin: string, profile: string): string {
    const lines = ['#EXTM3U'];
    for (const service of services) {
        lines.push(
            `#EXTINF:-1 tvg-id="${service.id}" tvg-name="${service.name}" group-title="${service.type}",${service.name}`,
            `${origin}/api/live/${service.id}/${profile}`,
        );
    }
    return `${lines.join('\n')}\n`;
}

export function xmltv(services: Service[], programs: Program[]): string {
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
        '<tv generator-info-name="denpa">',
    ];

    for (const service of services) {
        lines.push(
            `  <channel id="${service.id}">`,
            `    <display-name>${xml(service.name)}</display-name>`,
            '  </channel>',
        );
    }

    for (const program of programs) {
        lines.push(
            `  <programme start="${xmltvTime(program.start_at)}" stop="${xmltvTime(program.end_at)}" channel="${program.service_id}">`,
            `    <title lang="ja">${xml(program.name)}</title>`,
        );
        if (program.description !== '') {
            lines.push(`    <desc lang="ja">${xml(program.description)}</desc>`);
        }
        lines.push('  </programme>');
    }

    lines.push('</tv>', '');
    return lines.join('\n');
}
