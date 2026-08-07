import { queryAll } from '$lib/server/db';
import { airing, CURRENT_SERVICES, SERVICE_ORDER, SERVICE_TYPE_ORDER } from '$lib/server/epg';
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

export function load() {
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

    return { channels };
}
