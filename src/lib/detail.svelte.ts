import type { ProgramDetail } from './types';

/** 行が自分で持っている分。EPG から引けなくても、これだけは必ず出せる */
export interface DetailSeed {
    name: string;
    service_name: string;
    start_at: number;
    end_at: number;
    /** 一覧によっては持っていない (ルールのプレビューなど)。引けたら埋まる */
    description?: string;
}

/**
 * 行を押して出す番組詳細。**まず行が持っている分をすぐ出し、EPG から引けたら差し替える。**
 *
 * 引き終わってから出していた頃は、押してから中身が出るまで何も起きない間があった。
 * 古い録画は番組が EPG から消えているので、そもそも引けないことのほうが普通で、
 * そのときは行が持っている分だけが出たままになる。
 *
 * 予約・録画の一覧とルールのプレビューで同じものが要る。**開く手順を写していると
 * 片方だけ直したときに見え方がずれる** (実際、先に出す・あとで差し替えるという
 * 段取りそのものが2箇所にあった)。
 */
export function programDetail() {
    let current = $state<ProgramDetail | null>(null);
    /** 続けて別の行を押したとき、遅れて届いた前の結果で上書きされないようにする */
    let opened = 0;

    return {
        get current(): ProgramDetail | null {
            return current;
        },
        close(): void {
            current = null;
        },
        /**
         * 出す。番組が分からないもの (取り込んだ録画など) は `programId` に null を渡す。
         * 引けなければ行が持っている分のまま。
         */
        async open(programId: number | null, seed: DetailSeed): Promise<void> {
            const token = ++opened;
            current = {
                description: '',
                ...seed,
                extended: null,
                genre_detail: null,
                audios: null,
                video_type: null,
                video_resolution: null,
                is_free: 1,
            };
            if (programId === null) return;

            const res = await fetch(`/api/programs/${programId}`);
            if (res.ok && token === opened) current = await res.json();
        },
    };
}
