/**
 * チューナーの割り当てと競合判定。DBにもエージェントにも触らない純粋な計算にしてあるので、
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
function window(a: { start_at: number; end_at: number }, margins: Margins) {
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
 * 同じ物理チャンネルの同時録画はエージェントが1本のチューナーで捌けるので、
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

/**
 * 同じ時間帯にチューナーを掴むもの。ルール画面のプレビュー用。
 *
 * **予約とプレビューを1つに混ぜて数える。** 立っている予約としか突き合わせて
 * いなかった頃は、**まだ保存していないルールでは重なりが1件も出なかった**
 * (予約がまだ無いので比べる相手が居ない)。ルールが同時に3本録ろうとしていても
 * 画面は静かなままで、保存して初めて競合が出ていた。
 */
export interface Occupant {
    programId: number;
    name: string;
    serviceName: string;
    /** チャンネル種別。地上波と衛星は別のチューナーなので、取り合わない */
    type: string;
    channel: string;
    start_at: number;
    end_at: number;
}

/**
 * 重なりを探す相手。**開始順に並べて、探し始める位置を引けるようにしておく。**
 *
 * 番組は開始順に並べられるが、終了順ではない。ある時刻に掛かっているものを
 * 探すには「いちばん長い番組のぶんだけ手前」から見れば取りこぼさない。
 */
export interface Rivals {
    list: Occupant[];
    /** その時刻に掛かっている可能性のある、いちばん手前の位置 */
    from(at: number): number;
}

export function rivalsOf(occupants: Iterable<Occupant>, margins: Margins): Rivals {
    const list = [...occupants].sort((a, b) => a.start_at - b.start_at);
    const longest = list.reduce((max, o) => Math.max(max, o.end_at - o.start_at), 0);
    const slack = longest + margins.start + margins.end;
    return {
        list,
        from(at: number): number {
            // 開始が (at - いちばん長い番組) より前のものは、もう終わっている
            let low = 0;
            let high = list.length;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (list[mid].start_at < at - slack) low = mid + 1;
                else high = mid;
            }
            return low;
        },
    };
}

/**
 * **チューナーが足りなくなる相手だけ**を返す。ただ時間が重なっているだけでは出さない。
 *
 * 数え方は上の `assign` と同じにしてある (同じファイルに置いてあるのもそのため)。
 * ここだけ違う物差しで数えると、画面が「重なっています」と言っているのに
 * スケジューラは通す、という食い違いが出る。
 *
 * - **種別ごとに数える。** チューナーは GR / BS・CS で別々に刺さっている。
 *   全部まとめて数えていた頃は、**衛星の番組に地上波の番組が競合として出ていた**。
 * - **同じ物理チャンネルは1本で足りる。** エージェントが1本のチューナーを配るので、
 *   テレ東1と2のような相乗りは何本並んでも1本。
 * - **本数を超えて初めて競合。** 地上波チューナーが2本あるなら、別チャンネルの
 *   2番組が重なっていても録れる。重なりをそのまま出していた頃は、録れるものまで
 *   「重なっています」と出ていた。
 * - **本数が分からないときは何も言わない** (エージェントが落ちているとき)。
 *   `assign` も同じ扱いで、勝手に競合扱いにはしない。
 *
 * 最初の1件しか返していなかった頃は、3本ぶつかっていても画面には1本ぶんしか
 * 出ず、どれを諦めればいいのかが読めなかった。
 */
export function contending(
    row: { programId: number; type: string; channel: string; start_at: number; end_at: number },
    rivals: Rivals,
    capacity: Map<string, number>,
    margins: Margins,
): string[] {
    const limit = capacity.get(row.type);
    if (limit === undefined) return [];
    const mine = window(row, margins);

    /** 同じ種別で時間が重なっているもの。同じチャンネルのものも入れる (本数は1本で済む) */
    const overlapping: Occupant[] = [];
    // 総当たりにしない。ゆるい条件のルールは数千件に当たるので、
    // 1件ずつ全件と突き合わせると番組表の二乗ぶん回ることになる
    for (let at = rivals.from(mine.from); at < rivals.list.length; at++) {
        const other = rivals.list[at];
        const theirs = window(other, margins);
        // 並びは開始順。これより後ろは全部この番組より後に始まる
        if (theirs.from >= mine.to) break;
        if (other.programId === row.programId || other.type !== row.type) continue;
        if (theirs.to <= mine.from) continue;
        overlapping.push(other);
    }

    /*
     * 同時に何チャンネル要るか。**いちばん要る瞬間は必ずどれかの区間の開始時点に
     * 現れる**ので、そこだけ調べれば足りる (assign と同じ)。重なっている相手を
     * ただ全部足すと、互いには重なっていないもの同士まで一緒に数えてしまう
     */
    let worst = 0;
    let culprits: Occupant[] = [];
    for (const at of [mine.from, ...overlapping.map((o) => window(o, margins).from)]) {
        if (at < mine.from || at >= mine.to) continue;
        const together = overlapping.filter((o) => {
            const theirs = window(o, margins);
            return theirs.from <= at && at < theirs.to;
        });
        const channels = new Set([row.channel, ...together.map((o) => o.channel)]);
        if (channels.size > worst) {
            worst = channels.size;
            culprits = together;
        }
    }

    if (worst <= limit) return [];
    // 同じチャンネルの相手は名前を出さない。1本で足りるので、諦めても何も空かない
    return culprits.filter((o) => o.channel !== row.channel).map((o) => `${o.name} (${o.serviceName})`);
}
