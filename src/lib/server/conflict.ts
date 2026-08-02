/**
 * チューナーの割り当てと競合判定。DBにもmirakcにも触らない純粋な計算にしてあるので、
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

/**
 * 実際にチューナーを掴んでいる区間。
 *
 * 番組の時刻そのままで数えると、22:00 終了と 22:00 開始の予約が「重ならない」ことに
 * なってしまう。実際には前の録画は終了マージンぶん伸び、次の録画は開始マージンぶん
 * 早く始まるので、その間チューナーは2本要る。ここを見落とすと予約表では通っているのに
 * 実行時に「チューナーが空かない」で録り逃す。
 */
function window(a: Assignable, margins: Margins) {
    return { from: a.start_at - margins.start, to: a.end_at + margins.end };
}

export interface Margins {
    /** 開始何ms前から録り始めるか */
    start: number;
    /** 終了何ms後まで録り続けるか */
    end: number;
}

function overlaps(a: Assignable, b: Assignable, margins: Margins): boolean {
    const x = window(a, margins);
    const y = window(b, margins);
    return x.from < y.to && y.from < x.to;
}

/**
 * 優先度が高い順・開始が早い順に採用していき、入らなかったものを競合として返す。
 *
 * 同じ物理チャンネルの同時録画は mirakc が1本のチューナーで捌けるので、
 * 数えるのは「同時刻に開いている“異なるチャンネル”の数」。
 * capacity にその種別が無い場合は本数不明として無制限に扱う。
 */
export function assign<T extends Assignable>(
    candidates: T[],
    capacity: Map<string, number>,
    margins: Margins = { start: 0, end: 0 },
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

        const rivals = accepted.filter((a) => a.type === candidate.type && overlaps(a, candidate, margins));
        const mine = window(candidate, margins);
        // 同時本数の最大値は必ずどれかの区間の開始時点で現れるので、そこだけ調べれば足りる
        const instants = [mine.from, ...rivals.map((r) => window(r, margins).from)].filter(
            (t) => t >= mine.from && t < mine.to,
        );

        let worst = 0;
        for (const t of instants) {
            const channels = new Set([candidate.channel]);
            for (const rival of rivals) {
                const other = window(rival, margins);
                if (other.from <= t && t < other.to) channels.add(rival.channel);
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
