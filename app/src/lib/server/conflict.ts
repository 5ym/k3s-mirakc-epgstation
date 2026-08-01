/**
 * チューナーの割り当てと競合判定。DBにもMirakurunにも触らない純粋な計算にしてあるので、
 * 「2本のチューナーで3局を同時に録ろうとした」ような状況を単体テストで固定できる。
 */

export interface Assignable {
    id: number;
    start_at: number;
    end_at: number;
    priority: number;
    /** チャンネル種別 (GR/BS/CS)。チューナーはこの単位で本数が決まる */
    type: string;
    /** 物理チャンネル。同じチャンネルなら1本のチューナーを共有できる */
    channel: string;
}

export interface AssignResult<T extends Assignable> {
    accepted: T[];
    rejected: { reservation: T; reason: string }[];
}

function overlaps(a: Assignable, b: Assignable): boolean {
    return a.start_at < b.end_at && b.start_at < a.end_at;
}

/**
 * 優先度が高い順・開始が早い順に採用していき、入らなかったものを競合として返す。
 *
 * 同じ物理チャンネルの同時録画は Mirakurun が1本のチューナーで捌けるので、
 * 数えるのは「同時刻に開いている“異なるチャンネル”の数」。
 * capacity にその種別が無い場合は本数不明として無制限に扱う。
 */
export function assign<T extends Assignable>(
    candidates: T[],
    capacity: Map<string, number>,
): AssignResult<T> {
    const ordered = [...candidates].sort(
        (a, b) => b.priority - a.priority || a.start_at - b.start_at || a.id - b.id,
    );

    const accepted: T[] = [];
    const rejected: { reservation: T; reason: string }[] = [];

    for (const candidate of ordered) {
        const limit = capacity.get(candidate.type);
        if (limit === undefined) {
            accepted.push(candidate);
            continue;
        }

        const rivals = accepted.filter((a) => a.type === candidate.type && overlaps(a, candidate));
        // 同時本数の最大値は必ずどれかの区間の開始時点で現れるので、そこだけ調べれば足りる
        const instants = [candidate.start_at, ...rivals.map((r) => r.start_at)].filter(
            (t) => t >= candidate.start_at && t < candidate.end_at,
        );

        let worst = 0;
        for (const t of instants) {
            const channels = new Set([candidate.channel]);
            for (const rival of rivals) {
                if (rival.start_at <= t && t < rival.end_at) channels.add(rival.channel);
            }
            worst = Math.max(worst, channels.size);
        }

        if (worst > limit) {
            rejected.push({
                reservation: candidate,
                reason: `${candidate.type} のチューナー ${limit} 本に対し同時 ${worst} チャンネル必要`,
            });
        } else {
            accepted.push(candidate);
        }
    }

    return { accepted, rejected };
}
