import { LAST_COOKIE } from '$lib/live';
import { queryAll } from '$lib/server/db';
import { airing, CURRENT_SERVICES, SERVICE_ORDER, SERVICE_TYPE_ORDER } from '$lib/server/epg';
import { warm } from '$lib/server/live';
import type { Service } from '$lib/types';

/**
 * ライブ視聴で選べる局と、いま流れている番組。
 *
 * **番組表と同じ並びにする** (`SERVICE_ORDER`)。番組表で見つけた局を、ここでも
 * 同じ位置で探せるようにするため。
 *
 * 取り残しの局は出さない (`CURRENT_SERVICES` と `airing`)。出すと、選んでも
 * 映らない行が並ぶ — 終わったチャンネルの枠が SDT に残っていることがある。
 */
export interface LiveChannel {
    /** `service.id`。一覧の目印 */
    id: number;
    name: string;
    type: string;
    /** 物理チャンネル。これで選局する */
    channel: string;
    /**
     * テレビに出ている番号。**探すときの手掛かりはこれ。**
     *
     * 地上波はリモコン番号 (1〜12)。BS と CS は**サービスID がそのまま3桁番号**
     * にあたる (BS朝日1=151、WOWOWプライム=191、時代劇専門ch=292)。
     */
    number: number | null;
    hasLogo: boolean;
    /** いま流れている番組。無いこともある (番組表がまだ薄い局) */
    now: { name: string; startAt: number; endAt: number } | null;
}

/**
 * 画面が覚えている前回の局。**cookie から読む。**
 *
 * 覚え先そのものは localStorage (`live-player.svelte.ts` の `remember`) だが、
 * あちらはサーバから読めない。**繋いでくる前に焼きはじめる**ためだけに、
 * 同じものを cookie にも置いてもらっている。壊れていても無視するだけでよい —
 * 落ちたら「先に焼く相手が分からない」で、いつもどおりの速さに戻るだけ
 */
function remembered(
    raw: string | undefined,
    channels: LiveChannel[],
): { channel: LiveChannel; audio?: string } | null {
    if (raw === undefined) return null;
    try {
        const saved = JSON.parse(raw) as Record<string, unknown>;
        const found = channels.find(
            (channel) => channel.type === saved.channelType && channel.channel === saved.channel,
        );
        if (found === undefined) return null;
        return { channel: found, audio: typeof saved.audio === 'string' ? saved.audio : undefined };
    } catch {
        return null;
    }
}

export function load({ url, cookies }) {
    const at = Date.now();
    // テレビと同じ並び (SERVICE_TYPE_ORDER / SERVICE_ORDER)。番組表とも揃えてある
    const services = queryAll<Service>(
        `SELECT * FROM services WHERE ${CURRENT_SERVICES}
         ORDER BY ${SERVICE_TYPE_ORDER}, ${SERVICE_ORDER}`,
    );

    /*
     * いま流れているものだけ引く。番組表を丸ごと持ってくると、局の数 × 8日ぶんに
     * なって画面が出るまで待たされる (実機で 25,000 件を超える)
     */
    const now = queryAll<{ service_id: number; name: string; start_at: number; end_at: number }>(
        `SELECT service_id, name, start_at, end_at FROM programs
         WHERE start_at <= ? AND end_at > ?`,
        at,
        at,
    );
    const byService = new Map(now.map((program) => [program.service_id, program]));

    const channels: LiveChannel[] = airing(services, now).map((service) => {
        const program = byService.get(service.id);
        return {
            id: service.id,
            name: service.name,
            type: service.type,
            channel: service.channel,
            // 地上波はリモコン番号、BS/CS はサービスID がそのまま3桁番号
            number: service.remote_control_key ?? (service.type === 'GR' ? null : service.service_id),
            hasLogo: service.has_logo === 1,
            now:
                program === undefined
                    ? null
                    : { name: program.name, startAt: program.start_at, endAt: program.end_at },
        };
    });

    /*
     * **番組表の「視聴」から来たとき、その局** (`services.id`)。
     *
     * 画面が覚えている前回の局より優先させるためにここで確かめておく
     * (押した人はその局を見に来ている)。**居ない番号は渡さない** — 局が
     * 入れ替わったあとの古いリンクを踏んでも、いつもの前回の局で開く
     */
    const asked = Number(url.searchParams.get('service'));
    const initial = channels.some((channel) => channel.id === asked) ? asked : null;

    /*
     * **繋いでくる前に焼きはじめる** (`live.warm`)。
     *
     * これから開くのがどの局かは、ここで既に決まっている — 画面が `onMount` で
     * 選ぶのと同じ順 (名指し → 覚えている前回の局 → 一覧の先頭)。**順番を
     * 揃えておく**こと。ずれると、使われない焼きが1本立って畳まれるだけになる
     */
    const saved = initial === null ? remembered(cookies.get(LAST_COOKIE), channels) : null;
    const first = initial === null ? (saved?.channel ?? channels[0]) : channels.find((c) => c.id === initial);
    if (first !== undefined) warm(first.type, first.channel, first.id, saved?.audio);

    return { channels, initial };
}
