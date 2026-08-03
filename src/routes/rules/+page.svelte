<script lang="ts">
    import { submitting } from '$lib/actions';
    import { GENRE_TREE, genreName } from '$lib/arib';
    import Toasts, { type Notice } from '$lib/components/Toasts.svelte';
    import { badgeClass, CM_LABEL, dateTime, stateLabel } from '$lib/format';
    import { parseSearchFields, SEARCH_FIELD_LABEL, SEARCH_FIELDS, searchFieldLabel } from '$lib/search';

    let { data, form } = $props();

    /** フォームの初期値として選んでおくチャンネルと種別 */
    function parse(json: string | null): (string | number)[] {
        if (json === null) return [];
        try {
            return JSON.parse(json) as (string | number)[];
        } catch {
            return [];
        }
    }
    const seedTypes = $derived(parse(data.seed?.service_types ?? null).map(String));
    const seedServices = $derived(parse(data.seed?.service_ids ?? null).map(Number));
    const seedGenres = $derived(parse(data.seed?.genres ?? null).map(String));
    const seedFields = $derived(parseSearchFields(data.seed?.search_fields));

    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS', SKY: 'SKY' };

    /** JSON で持っている条件を読む。壊れていれば「条件なし」と同じ扱いにする */
    function list<T>(json: string | null): T[] {
        if (json === null || json === '') return [];
        try {
            const value = JSON.parse(json);
            return Array.isArray(value) ? (value as T[]) : [];
        } catch {
            return [];
        }
    }

    function channels(rule: { service_types: string | null; service_ids: string | null }): string {
        const parts = [
            ...list<string>(rule.service_types).map((t) => TYPE_LABEL[t] ?? t),
            ...list<number>(rule.service_ids).map(
                (id) => data.services.find((s) => s.id === id)?.name ?? String(id),
            ),
        ];
        return parts.length === 0 ? '全局' : parts.join(', ');
    }

    /** 絞り込んでいるジャンル。条件のうち一番見落としやすいので独立した列に出す */
    function genres(rule: { genres: string | null }): string {
        const parts = list<string | number>(rule.genres).map(genreName);
        return parts.length === 0 ? '全ジャンル' : parts.join(', ');
    }

    /** チャンネルは50局以上あるので種別ごとにまとめる */
    const grouped = $derived(
        ['GR', 'BS', 'CS', 'SKY']
            .map((type) => ({ type, services: data.services.filter((s) => s.type === type) }))
            .filter((g) => g.services.length > 0),
    );

    /** 押した結果 */
    const notices = $derived<Notice[]>(
        form?.message ? [{ key: 'rule-error', kind: 'error', text: form.message }] : [],
    );
</script>

<h1 class="mb-4 text-2xl font-bold">自動予約ルール</h1>

<Toasts {notices} source={form} />

<div class="card bg-base-100 mb-6 shadow">
    <div class="card-body">
        <h2 class="card-title">{data.editing ? 'ルールを編集' : 'ルールを追加'}</h2>
        <p class="text-base-content/70 text-sm">
            条件に合う番組を、これから放送されるぶんから自動で予約します。ルール名はキーワードから付きます。
        </p>

        <!-- 横に広げて縦を詰める。条件を見比べながら決めるものなので、
             スクロールしないと全体が見えないのは使いにくい -->
        <form method="POST" use:submitting class="mt-2 space-y-4">
            {#if data.editing}
                <input type="hidden" name="id" value={data.editing.id} />
                <!-- 「この条件で何が録れるか見る」は GET でこの画面に戻ってくる。
                     どのルールを編集していたかを持ち回らないと、追加の画面に戻ってしまう -->
                <input type="hidden" name="edit" value={data.editing.id} />
            {/if}
            <!--
                チェックを外した状態は GET だと「キー自体が無い」になって、
                番組表から keyword だけ渡されたときと見分けが付かない。
                この印があるときはチェックボックスの状態をそのまま信じる
            -->
            <input type="hidden" name="form" value="rules" />

            <div class="grid gap-4 lg:grid-cols-3">
                <label class="flex flex-col gap-1">
                    <span class="text-sm font-medium">キーワード</span>
                    <input
                        name="keyword"
                        class="input input-bordered w-full"
                        placeholder="例: 名探偵"
                        value={data.seed?.keyword ?? ''}
                        data-testid="rule-keyword"
                    />
                    <span class="text-base-content/60 text-xs">
                        空白区切りは<strong>すべて含む</strong>もの
                    </span>
                    <!--
                        当てる範囲。既定は番組名だけ。概要まで広げると番宣で名前が出ただけの
                        番組を拾い、詳細まで広げると出演者でも拾える
                    -->
                    <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1" data-testid="rule-search-fields">
                        {#each SEARCH_FIELDS as field (field)}
                            <label class="flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="searchFields"
                                    value={field}
                                    checked={seedFields.includes(field)}
                                    class="checkbox checkbox-xs"
                                />
                                <span class="text-xs">{SEARCH_FIELD_LABEL[field]}</span>
                            </label>
                        {/each}
                    </div>
                </label>
                <label class="flex flex-col gap-1">
                    <span class="text-sm font-medium">除外キーワード</span>
                    <input
                        name="ignoreKeyword"
                        class="input input-bordered w-full"
                        placeholder="例: 再放送 総集編"
                        value={data.seed?.ignore_keyword ?? ''}
                        data-testid="rule-ignore"
                    />
                    <span class="text-base-content/60 text-xs">
                        空白区切りは<strong>どれか1つでも含む</strong>ものを除外
                    </span>
                </label>
                <label class="flex flex-col gap-1">
                    <span class="text-sm font-medium">優先度</span>
                    <input
                        type="number"
                        name="priority"
                        value={data.seed?.priority ?? 2}
                        min="0"
                        max="9"
                        class="input input-bordered w-full"
                        data-testid="rule-priority"
                    />
                    <span class="text-base-content/60 text-xs">
                        チューナーが足りないとき<strong>大きいほうを残します</strong>(手動予約は 3)
                    </span>
                </label>
            </div>

            <div class="grid items-start gap-4 lg:grid-cols-2">
                <details class="border-base-300 rounded-box border">
                    <summary
                        class="cursor-pointer px-4 py-3 text-sm font-medium"
                        data-testid="channel-summary"
                    >
                        チャンネル
                        <span class="text-base-content/60">
                            ({seedTypes.length + seedServices.length === 0
                                ? '全局'
                                : `${seedTypes.length + seedServices.length} 件選択中`})
                        </span>
                    </summary>
                    <div class="space-y-3 px-4 pb-4">
                        <div>
                            <div class="text-base-content/60 mb-1 text-xs font-bold">まとめて選ぶ</div>
                            <div class="flex flex-wrap gap-x-4 gap-y-1" data-testid="rule-types">
                                {#each grouped as group (group.type)}
                                    <label class="flex cursor-pointer items-center gap-2">
                                        <input
                                            type="checkbox"
                                            name="serviceTypes"
                                            value={group.type}
                                            checked={seedTypes.includes(group.type)}
                                            class="checkbox checkbox-sm"
                                        />
                                        <span class="text-sm">
                                            {TYPE_LABEL[group.type] ?? group.type}
                                            <span class="text-base-content/60">
                                                ({group.services.length})
                                            </span>
                                        </span>
                                    </label>
                                {/each}
                            </div>
                        </div>
                        <div>
                            <div class="text-base-content/60 mb-1 text-xs font-bold">個別に選ぶ</div>
                            <div class="max-h-48 space-y-2 overflow-y-auto" data-testid="rule-services">
                                {#each grouped as group (group.type)}
                                    <div>
                                        <div class="text-base-content/60 mb-1 text-xs">
                                            {TYPE_LABEL[group.type] ?? group.type}
                                        </div>
                                        <div class="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                                            {#each group.services as service (service.id)}
                                                <label class="flex cursor-pointer items-center gap-2">
                                                    <input
                                                        type="checkbox"
                                                        name="serviceIds"
                                                        value={service.id}
                                                        checked={seedServices.includes(service.id)}
                                                        class="checkbox checkbox-sm"
                                                    />
                                                    <span class="truncate text-sm">{service.name}</span>
                                                </label>
                                            {/each}
                                        </div>
                                    </div>
                                {:else}
                                    <p class="text-base-content/60 text-sm">
                                        チャンネルがまだ取り込まれていません。チューナー画面でチャンネルスキャンを実行してください。
                                    </p>
                                {/each}
                            </div>
                        </div>
                    </div>
                </details>

                <details class="border-base-300 rounded-box border">
                    <summary class="cursor-pointer px-4 py-3 text-sm font-medium" data-testid="genre-summary">
                        ジャンル
                        <span class="text-base-content/60">
                            ({seedGenres.length === 0 ? '全ジャンル' : `${seedGenres.length} 件選択中`})
                        </span>
                    </summary>
                    <div class="px-4 pb-4">
                        <!-- 大分類だけ選べば中分類は問わない。細かく絞りたいときだけ
                             中分類にチェックを入れる -->
                        <div class="max-h-64 space-y-2 overflow-y-auto" data-testid="rule-genres">
                            {#each GENRE_TREE as group (group.value)}
                                <div>
                                    <label class="flex cursor-pointer items-center gap-2">
                                        <input
                                            type="checkbox"
                                            name="genres"
                                            value={group.value}
                                            checked={seedGenres.includes(group.value)}
                                            class="checkbox checkbox-sm"
                                        />
                                        <span class="text-sm font-medium">{group.label}</span>
                                        <span class="text-base-content/60 text-xs">(すべて)</span>
                                    </label>
                                    {#if group.children.length > 0}
                                        <div class="mt-1 ml-6 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                                            {#each group.children as child (child.value)}
                                                <label class="flex cursor-pointer items-center gap-2">
                                                    <input
                                                        type="checkbox"
                                                        name="genres"
                                                        value={child.value}
                                                        checked={seedGenres.includes(child.value)}
                                                        class="checkbox checkbox-xs"
                                                    />
                                                    <span class="truncate text-xs">{child.label}</span>
                                                </label>
                                            {/each}
                                        </div>
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    </div>
                </details>
            </div>

            <p class="text-base-content/60 text-sm">
                エンコードのしかたと無料放送の扱いは<a class="link" href="/settings">設定</a>で決めます ({data.defaults.codec.toUpperCase()}
                / CM: {CM_LABEL[data.defaults.cmCut]}{data.defaults.freeOnly ? ' / 無料放送のみ' : ''})
            </p>

            <div class="flex flex-wrap gap-2">
                <button class="btn" formmethod="GET" formaction="/rules" data-testid="rule-preview">
                    この条件で何が録れるか見る
                </button>
                {#if data.editing}
                    <button class="btn btn-primary" formaction="?/update" data-testid="rule-update">
                        更新
                    </button>
                    <a class="btn" href="/rules" data-testid="rule-cancel-edit">やめる</a>
                {:else}
                    <button class="btn btn-primary" formaction="?/create" data-testid="rule-submit">
                        追加
                    </button>
                {/if}
            </div>
        </form>

        <!--
            このルールが押さえている予約。**フォームの外に出す。**
            中に入れると form が入れ子になって、1件取り消すつもりで
            ルールの更新まで送ってしまう。

            条件を狭めても既に立った予約は残る (意図して個別に残していることが
            あるので勝手には消さない) ので、要らないものだけここで外す
        -->
    </div>
</div>

{#if data.preview}
    <!--
        **予約とプレビューは同じ表**。別々に並べていた頃は、同じ番組が2箇所に出るうえ、
        「押さえている予約」と「これから当たる番組」を頭の中で突き合わせることになっていた
    -->
    <div class="card bg-base-100 mb-6 shadow" data-testid="preview">
        <div class="card-body">
            <h2 class="card-title text-base">
                この条件で録れる番組は {data.preview.total} 件
                {#if data.preview.total > data.preview.programs.length}
                    <span class="text-base-content/60 text-sm font-normal">
                        (先頭 {data.preview.programs.length} 件)
                    </span>
                {/if}
                {#if data.preview.conflicts > 0}
                    <span class="badge badge-sm badge-error badge-outline" data-testid="preview-conflicts">
                        競合 {data.preview.conflicts} 件
                    </span>
                {/if}
            </h2>
            {#if data.preview.total === 0}
                <p class="text-base-content/60 text-sm">
                    いまの番組表では1件も当たりません。条件を緩めてください。
                </p>
            {:else}
                <p class="text-base-content/60 text-xs">
                    予約済みのものはここで取り消せます (取り消した番組をルールが取り直すことはありません)。
                    条件を変えても既に立った予約は残るので、条件から外れたものも
                    <span class="badge badge-xs badge-ghost">条件外</span> として並べます。
                </p>
                <ul class="divide-base-300 mt-1 divide-y" data-testid="preview-list">
                    {#each data.preview.programs as program (program.id)}
                        <li
                            class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm"
                            data-testid="preview-row"
                            data-program-id={program.id}
                        >
                            <div class="min-w-0 flex-1 basis-64">
                                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    {#if program.reservation_state}
                                        <span
                                            class="badge badge-sm {badgeClass(program.reservation_state)}"
                                            data-testid="preview-state"
                                        >
                                            {stateLabel(program.reservation_state)}
                                        </span>
                                    {/if}
                                    {#if !program.matched}
                                        <span class="badge badge-xs badge-ghost">条件外</span>
                                    {/if}
                                    <span class="truncate">{program.name}</span>
                                </div>
                                <div class="text-base-content/60 text-xs">
                                    {program.service_name} ・ {dateTime(program.start_at)}
                                </div>
                                <!--
                                    重なりは**録ろうとした時点で初めて分かる**ので、
                                    ここで先に見せる。同じ物理チャンネルのものは
                                    重ならない (mirakc がチューナーを配る)。

                                    **重なっているものは全部出す。** 1件だけ出していた頃は、
                                    3本ぶつかっていても1本しか見えず、どれを諦めれば
                                    いいのかが読めなかった
                                -->
                                {#if program.conflict_reason}
                                    <div class="text-error text-xs" data-testid="preview-conflict">
                                        {program.conflict_reason}
                                    </div>
                                {/if}
                                {#if program.conflicts.length > 0}
                                    <!--
                                        件数は本当の数、名前は先頭だけ。ゆるい条件だと
                                        1つの番組に何十本もぶつかることがあり、全部並べると
                                        1行が画面何個ぶんにもなる (件数さえ合っていれば
                                        「多すぎる」ことは伝わる)
                                    -->
                                    <div class="text-error text-xs" data-testid="preview-conflict">
                                        重なり {program.conflicts.length} 件: {program.conflicts
                                            .slice(0, 3)
                                            .join('、')}{program.conflicts.length > 3
                                            ? ` ほか ${program.conflicts.length - 3} 件`
                                            : ''}
                                    </div>
                                {/if}
                            </div>
                            {#if program.reservation_id !== null}
                                <form method="POST" action="?/cancelReservation" use:submitting>
                                    <input
                                        type="hidden"
                                        name="reservationId"
                                        value={program.reservation_id}
                                    />
                                    <button
                                        class="btn btn-xs btn-error btn-outline"
                                        data-testid="rule-pending-cancel"
                                    >
                                        取消
                                    </button>
                                </form>
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </div>
{/if}

<div class="mb-2 flex justify-end">
    <form method="POST" action="?/apply" use:submitting>
        <button class="btn btn-sm" data-testid="rule-apply">今すぐ全ルールを適用</button>
    </form>
</div>

<div class="overflow-x-auto rounded-box bg-base-100 shadow">
    <table class="table table-zebra">
        <thead>
            <tr>
                <th>ルール</th>
                <th>除外</th>
                <th>チャンネル</th>
                <th>ジャンル</th>
                <th>優先度</th>
                <th>予約数</th>
                <th class="w-56"></th>
            </tr>
        </thead>
        <tbody data-testid="rule-list">
            {#each data.rules as rule (rule.id)}
                <tr data-testid="rule-row" data-rule-id={rule.id}>
                    <td>
                        <div class="font-medium">{rule.name}</div>
                        <span class="badge badge-sm {rule.enabled ? 'badge-success' : 'badge-ghost'}">
                            {rule.enabled ? '有効' : '無効'}
                        </span>
                        <!-- どこを見て当たったのか分からないと、絞り込みの直しようがない -->
                        {#if rule.keyword}
                            <span class="text-base-content/60 text-xs" data-testid="rule-search-scope">
                                {searchFieldLabel(rule.search_fields)}から
                            </span>
                        {/if}
                    </td>
                    <td class="text-error text-sm">{rule.ignore_keyword || '-'}</td>
                    <td class="max-w-48 text-sm" data-testid="rule-channels">{channels(rule)}</td>
                    <td class="max-w-48 text-sm" data-testid="rule-genres-label">{genres(rule)}</td>
                    <td>{rule.priority}</td>
                    <td>{rule.reservations}</td>
                    <td class="flex flex-nowrap gap-2">
                        <a
                            class="btn btn-sm whitespace-nowrap"
                            href="/rules?edit={rule.id}"
                            data-testid="rule-edit">編集</a
                        >
                        <form method="POST" action="?/toggle" use:submitting>
                            <input type="hidden" name="id" value={rule.id} />
                            <button class="btn btn-sm whitespace-nowrap" data-testid="rule-toggle">
                                {rule.enabled ? '無効化' : '有効化'}
                            </button>
                        </form>
                        <form method="POST" action="?/delete" use:submitting>
                            <input type="hidden" name="id" value={rule.id} />
                            <button
                                class="btn btn-sm btn-error btn-outline whitespace-nowrap"
                                data-testid="rule-delete"
                            >
                                削除
                            </button>
                        </form>
                    </td>
                </tr>
            {:else}
                <tr><td colspan="7" class="text-base-content/60">ルールはまだありません</td></tr>
            {/each}
        </tbody>
    </table>
</div>
