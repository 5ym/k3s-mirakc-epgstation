import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LogoCollector } from '../ts/logo';
import { config } from './config';
import { database, now, queryAll, queryOne } from './db';
import { emit } from './events';
import { openServiceStream } from './mirakc';
import { chunks } from './stream';

/**
 * 局ロゴを集める。
 *
 * mirakc は Mirakurun と違って**ロゴを TS から集めない**ので、denpa が拾う。
 * 集め方は Mirakurun と同じで、開いているストリームに相乗りする。
 *
 * ロゴは滅多に変わらないうえ、放送波に流れてくるのは数十秒〜数分に一度なので、
 * 録画のついでに拾えたら儲けもの、くらいの扱いにしてある。持っていない局が
 * 残っていれば、空いている時間に短く開いて取りに行く。
 */

/** 1局あたりの取得にかける上限。長く開くとチューナーを塞ぐ */
const SWEEP_TIMEOUT = 60_000;
/** ロゴを取りに行くときの優先度。録画より低くして、必要なら奪われるようにする */
const SWEEP_PRIORITY = 0;

function logoDir(): string {
    return join(config.dataDir, 'logos');
}

/** サービスIDごとのファイル。mirakc の内部IDをそのまま名前にする */
export function logoPath(serviceId: number): string {
    return join(logoDir(), `${serviceId}.png`);
}

export function readLogo(serviceId: number): Uint8Array | null {
    const path = logoPath(serviceId);
    if (!existsSync(path)) return null;
    try {
        return readFileSync(path);
    } catch {
        return null;
    }
}

/**
 * 拾えたロゴを保存して、番組表に出せるようにする。
 *
 * 放送波の service_id は ARIB のもので、denpa が持っている services.id とは
 * 別物。network_id と合わせて引き直す。
 */
function store(networkId: number, serviceIds: number[], data: Uint8Array): number {
    mkdirSync(logoDir(), { recursive: true });

    let saved = 0;
    for (const serviceId of serviceIds) {
        const service = queryAll<{ id: number }>(
            'SELECT id FROM services WHERE network_id = ? AND service_id = ?',
            networkId,
            serviceId,
        );
        for (const { id } of service) {
            // 書きかけを読ませない。番組表は同時に見に来る
            const working = `${logoPath(id)}.writing`;
            writeFileSync(working, data);
            renameSync(working, logoPath(id));
            database()
                .prepare('UPDATE services SET has_logo = 1, updated_at = ? WHERE id = ?')
                .run(now(), id);
            saved++;
        }
    }
    return saved;
}

/**
 * ストリームに相乗りしてロゴを拾う。
 *
 * 録画の本流を邪魔しないよう、失敗しても黙って諦める。ロゴが無くても
 * 番組表は出るし、録画には何の関係も無い。
 */
export function watch(serviceId: number): (chunk: Uint8Array) => void {
    const collector = new LogoCollector();
    // 放送波の service_id は ARIB のもので、denpa の services.id とは別物。
    // どのネットワークの話かはこちらが知っている
    const service = queryOne<{ network_id: number }>(
        'SELECT network_id FROM services WHERE id = ?',
        serviceId,
    );
    let done = service === undefined;

    return (chunk) => {
        if (done) return;
        try {
            collector.feed(chunk);
            const found = collector.collected();
            if (found.length === 0) return;

            let saved = 0;
            for (const { serviceIds, logo } of found) {
                saved += store(service!.network_id, serviceIds, logo.data);
            }
            // 1本の録画で何度も書きに行かない。ロゴは滅多に変わらない
            done = true;
            if (saved > 0) emit('services');
        } catch (error) {
            console.error(`[logo] 取り込みに失敗しました: ${error}`);
            done = true;
        }
    };
}

/** ロゴをまだ持っていない局 */
export function missing(): { id: number; network_id: number; name: string }[] {
    return queryAll<{ id: number; network_id: number; name: string }>(
        'SELECT id, network_id, name FROM services WHERE has_logo = 0 ORDER BY type, channel, service_id',
    );
}

/**
 * 持っていない局のロゴを取りに行く。
 *
 * 録画と同じ口を短く開くだけ。優先度を下げてあるので、チューナーが足りなければ
 * mirakc が録画のほうを通す。
 */
export async function sweep(limit = 1): Promise<number> {
    let found = 0;
    for (const service of missing().slice(0, limit)) {
        const controller = new AbortController();
        const stop = setTimeout(() => controller.abort(), SWEEP_TIMEOUT);
        try {
            const stream = await openServiceStream(service.id, controller.signal, SWEEP_PRIORITY);
            const collect = watch(service.id);
            for await (const chunk of chunks(stream)) {
                collect(chunk);
                if (readLogo(service.id) !== null) {
                    found++;
                    break;
                }
            }
        } catch {
            // 取れなければ次の機会に。チューナーが空いていないだけのことも多い
        } finally {
            clearTimeout(stop);
            controller.abort();
        }
    }
    return found;
}
