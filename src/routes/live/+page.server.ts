import { queryAll } from '$lib/server/db';
import { airing, CURRENT_SERVICES } from '$lib/server/epg';
import type { Service } from '$lib/types';

/**
 * ライブ視聴で選べる局と、いま流れている番組。
 *
 * **番組表と同じ並びにする。** テレビと同じくリモコン番号順で、番号を持たない局
 * (BS/CS) は物理チャンネル順で後ろに続く。番組表で見つけた局を、ここでも同じ
 * 位置で探せるようにするため。
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
    remoteControlKey: number | null;
    hasLogo: boolean;
    /** いま流れている番組。無いこともある (番組表がまだ薄い局) */
    now: { name: string; startAt: number; endAt: number } | null;
}

export function load() {
    const at = Date.now();
    /*
     * **地上波・BS・CS の順。** `ORDER BY type` にしていた頃は字の順に並んで
     * BS が先頭に来ていた。テレビは地上波から始まるし、番組表の切り替えも
     * その並びなので、ここだけ違うと探す場所がずれる。
     */
    const services = queryAll<Service>(
        `SELECT * FROM services WHERE ${CURRENT_SERVICES}
         ORDER BY CASE type WHEN 'GR' THEN 0 WHEN 'BS' THEN 1 ELSE 2 END,
                  remote_control_key IS NULL, remote_control_key, channel, service_id`,
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
            remoteControlKey: service.remote_control_key,
            hasLogo: service.has_logo === 1,
            now:
                program === undefined
                    ? null
                    : { name: program.name, startAt: program.start_at, endAt: program.end_at },
        };
    });

    return { channels };
}
