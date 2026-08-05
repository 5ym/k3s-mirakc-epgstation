/**
 * DB に JSON の文字列で持っている列を読む。
 *
 * **読めなければ空。** 入っているのは「ルールの対象チャンネル」「番組のジャンル」の
 * ような**条件の並び**で、読めないときに例外を投げると画面ごと出なくなる。
 * 空にしておけば「条件なし」と同じ扱いで、そこだけが抜けて残りは見えます。
 *
 * 取り込みの時期によっては列そのものが空のこともあります (`null` / `''`)。
 */
export function jsonArray<T>(json: string | null | undefined): T[] {
    if (json === null || json === undefined || json === '') return [];
    try {
        const value = JSON.parse(json);
        // 配列以外が入っていたら、壊れているものとして捨てる
        return Array.isArray(value) ? (value as T[]) : [];
    } catch {
        return [];
    }
}
