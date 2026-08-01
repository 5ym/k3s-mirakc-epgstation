import type { Service } from '../types';
import { config } from './config';
import { queryOne } from './db';
import { openServiceStream } from './mirakurun';

/**
 * ライブ中継。Mirakurun の MPEG-2 を変換して HTTP で流し続ける。
 *
 * 視聴用のUIは denpa には持たない。この出口は Jellyfin のライブTV(M3U Tuner)に
 * 食わせるためのもので、視聴は Jellyfin 側で行う。
 *
 * Mirakurun の `/api/iptv/*` を直接 Jellyfin に渡すこともできるが、それだと
 * Jellyfin が MPEG-2 を受け取って実時間トランスコードすることになり、コーデックも
 * プリセットも字幕の扱いもこちらから指定できない。先に denpa が変換して渡せば、
 * Jellyfin 側はリマックスするだけで済み、中身はこちらが握れる。
 */

export interface LiveProfile {
    id: string;
    name: string;
    description: string;
    contentType: string;
    args: string[];
}

/**
 * ARIB字幕のデコード設定。録画側(encoder.ts)と同じで、
 * 再生側のフォントに依存しないようビットマップとして取り出す。
 * デコーダのオプションなので入力より前に置く必要がある。
 */
function aribInput(): string[] {
    return [
        '-y',
        '-dual_mono_mode',
        'main',
        '-fix_sub_duration',
        '-sub_type',
        'bitmap',
        '-font',
        'Rounded M+ 1m for ARIB',
        '-f',
        'mpegts',
        // 解析を短く切らないと、再生開始までに数秒待たされる
        '-analyzeduration',
        '500000',
        '-i',
        'pipe:0',
        '-fflags',
        'nobuffer',
        '-ignore_unknown',
    ];
}

/**
 * インタレ解除は録画側と違い send_frame(既定の send_field ではない)にして 29.97p で出す。
 * 59.94p にするとエンコード量が倍になり、実時間に間に合わなくなるため。
 */
const DEINTERLACE = 'bwdif=mode=send_frame';

export function h264Args(): string[] {
    return [
        ...aribInput(),
        '-flags',
        'low_delay',
        '-max_delay',
        '250000',
        '-max_interleave_delta',
        '1',

        '-map',
        '0:v',
        // H.264 は8bitにしておく。10bitはデコードできないクライアントが残っている
        '-vf',
        `${DEINTERLACE},format=yuv420p`,
        '-c:v',
        'libx264',
        '-preset',
        config.livePreset,
        '-tune',
        'zerolatency',
        '-crf',
        String(config.liveCrf),
        // 2秒ごとにキーフレーム。途中から観ても待たされず、Jellyfin の分割単位にも合う
        '-g',
        '60',
        '-flags',
        '+cgop',

        '-map',
        '0:a:0',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ac',
        '2',

        // DVB字幕は MPEG-TS 本来の字幕形式で、Jellyfin もそのまま扱える
        '-map',
        '0:s?',
        '-c:s',
        'dvbsub',

        '-f',
        'mpegts',
        'pipe:1',
    ];
}

export function av1Args(): string[] {
    return [
        ...aribInput(),

        '-map',
        '0:v',
        '-vf',
        `${DEINTERLACE},format=yuv420p10le`,
        '-c:v',
        'libsvtav1',
        '-preset',
        String(config.liveAv1Preset),
        '-crf',
        String(config.liveCrf),
        '-g',
        '60',

        '-map',
        '0:a:0',
        '-c:a',
        'libopus',
        '-b:a',
        '192k',

        // dvdsub は MPEG-TS に入れられないので Matroska で包む。
        // AV1 + Opus + dvdsub の組み合わせは録画済みファイルと同じ構成になる
        '-map',
        '0:s?',
        '-c:s',
        'dvdsub',

        '-f',
        'matroska',
        // シークできない出力向けの書き方にする
        '-live',
        '1',
        'pipe:1',
    ];
}

export const PROFILES: LiveProfile[] = [
    {
        id: 'h264',
        name: 'H.264',
        description: 'H.264 + AAC + DVB字幕 を MPEG-TS で。CPUだけでも実時間で回る',
        contentType: 'video/mp2t',
        get args() {
            return h264Args();
        },
    },
    {
        id: 'av1',
        name: 'AV1',
        description: 'AV1 + Opus + dvdsub を Matroska で。録画済みファイルと同じ構成',
        contentType: 'video/x-matroska',
        get args() {
            return av1Args();
        },
    },
];

export function findProfile(id: string | null | undefined): LiveProfile | undefined {
    return PROFILES.find((p) => p.id === id);
}

export interface LiveSession {
    id: number;
    serviceId: number;
    serviceName: string;
    profile: string;
    startedAt: number;
    /**
     * 最後にストリームが読み出された時刻。
     * リバースプロキシや開発サーバがクライアントの切断を伝えてこないことがあるため、
     * これを見て取り残された中継を回収する(でないとチューナーを掴んだままになる)。
     */
    lastAccessAt: number;
}

interface Entry {
    session: LiveSession;
    stop: () => void;
}

let nextSessionId = 1;
const active = new Map<number, Entry>();

export function sessions(): LiveSession[] {
    return [...active.values()].map((e) => e.session).sort((a, b) => a.startedAt - b.startedAt);
}

export function stopSession(id: number): boolean {
    const entry = active.get(id);
    if (entry === undefined) return false;
    entry.stop();
    return true;
}

export function stopAll(): void {
    for (const entry of [...active.values()]) entry.stop();
}

/**
 * 元のストリームを包んで、中継が終わった(相手が切った・エラーになった)ときに
 * 後始末が必ず走るようにする。HTTPレスポンスのbodyがキャンセルされると cancel が呼ばれる。
 */
function tracked(
    source: ReadableStream<Uint8Array>,
    session: LiveSession,
    cleanup: () => void,
): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            // 読み出されている = まだ観られている
            session.lastAccessAt = Date.now();
            try {
                const chunk = await reader.read();
                if (chunk.done) {
                    controller.close();
                    finish();
                    return;
                }
                controller.enqueue(chunk.value);
            } catch (error) {
                controller.error(error);
                finish();
            }
        },
        cancel(reason) {
            void reader.cancel(reason).catch(() => {});
            finish();
        },
    });
}

/**
 * Mirakurun への優先度は既定(0)のままにしてあり、録画(優先度2)より弱い。
 * 空きチューナーが無い状態で録画が始まると中継側が切られる。
 * 録画を取りこぼすより視聴が切れるほうが良い、という判断。
 */
const VIEW_PRIORITY = 0;

export async function start(
    serviceId: number,
    profileId: string,
): Promise<{ stream: ReadableStream<Uint8Array>; session: LiveSession; contentType: string }> {
    const profile = findProfile(profileId);
    if (profile === undefined) throw new Error(`不明なプロファイル: ${profileId}`);

    const target = queryOne<Service>('SELECT * FROM services WHERE id = ?', serviceId);
    if (target === undefined) throw new Error(`チャンネル ${serviceId} が見つかりません`);

    const controller = new AbortController();
    const upstream = await openServiceStream(serviceId, controller.signal, VIEW_PRIORITY);

    const proc = Bun.spawn([config.ffmpeg, ...profile.args], {
        stdin: upstream,
        stdout: 'pipe',
        stderr: 'ignore',
    });

    const id = nextSessionId++;
    const at = Date.now();
    const session: LiveSession = {
        id,
        serviceId,
        serviceName: target.name,
        profile: profile.id,
        startedAt: at,
        lastAccessAt: at,
    };
    const stop = () => {
        active.delete(id);
        controller.abort();
        try {
            proc.kill();
        } catch {
            // 既に終わっていれば何もしない
        }
    };
    active.set(id, { session, stop });

    return {
        stream: tracked(proc.stdout as ReadableStream<Uint8Array>, session, stop),
        session,
        contentType: profile.contentType,
    };
}

/** 誰も読んでいない中継を止めてチューナーを解放する。定期実行される */
export function reapIdle(at = Date.now()): number {
    let stopped = 0;
    for (const entry of [...active.values()]) {
        if (at - entry.session.lastAccessAt < config.liveIdleTimeout) continue;
        entry.stop();
        stopped++;
        console.log(`[live] 読まれていないので中継を止めました: ${entry.session.serviceName}`);
    }
    return stopped;
}
