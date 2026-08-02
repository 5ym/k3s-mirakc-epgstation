/**
 * ルールのキーワードを当てる範囲。画面とサーバの両方で使う。
 *
 * 既定は番組名だけ。概要まで広げると「番宣で名前が出ただけ」の番組を拾い、
 * 詳細まで広げると出演者でも拾える(出演者は詳細にしか入っていない)。
 */

export const SEARCH_FIELDS = ['name', 'description', 'extended'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

export const SEARCH_FIELD_LABEL: Record<SearchField, string> = {
    name: '番組名',
    description: '概要',
    extended: '詳細',
};

/** カンマ区切りを読む。全部外れているルールは全番組に当たるので番組名だけに戻す */
export function parseSearchFields(value: string | null | undefined): SearchField[] {
    const wanted = String(value ?? '')
        .split(',')
        .map((part) => part.trim());
    const fields = SEARCH_FIELDS.filter((field) => wanted.includes(field));
    return fields.length === 0 ? ['name'] : fields;
}

/** ルール一覧に出す表示。「番組名・概要」のような形 */
export function searchFieldLabel(value: string | null | undefined): string {
    return parseSearchFields(value)
        .map((field) => SEARCH_FIELD_LABEL[field])
        .join('・');
}
