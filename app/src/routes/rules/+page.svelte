<script lang="ts">
    import { submitting } from '$lib/actions';
    import { GENRE_OPTIONS, genreName } from '$lib/arib';
    import { CM_LABEL, dateTime } from '$lib/format';

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
    const seedGenres = $derived(parse(data.seed?.genres ?? null).map(Number));

    const TYPE_LABEL: Record<string, string> = { GR: '地上波', BS: 'BS', CS: 'CS', SKY: 'SKY' };

    function describe(rule: {
        service_types: string | null;
        service_ids: string | null;
        genres: string | null;
    }): string {
        const parts: string[] = [];
        try {
            if (rule.service_types !== null) {
                parts.push(...(JSON.parse(rule.service_types) as string[]).map((t) => TYPE_LABEL[t] ?? t));
            }
            if (rule.service_ids !== null) {
                parts.push(
                    ...(JSON.parse(rule.service_ids) as number[]).map(
                        (id) => data.services.find((s) => s.id === id)?.name ?? String(id),
                    ),
                );
            }
            if (rule.genres !== null) {
                parts.push(...(JSON.parse(rule.genres) as number[]).map(genreName));
            }
        } catch {
            return 'すべて';
        }
        return parts.length === 0 ? 'すべて' : parts.join(', ');
    }

    /** チャンネルは50局以上あるので種別ごとにまとめる */
    const grouped = $derived(
        ['GR', 'BS', 'CS', 'SKY']
            .map((type) => ({ type, services: data.services.filter((s) => s.type === type) }))
            .filter((g) => g.services.length > 0),
    );
</script>

<h1 class="mb-4 text-2xl font-bold">自動予約ルール</h1>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="rule-error">{form.message}</div>
{/if}

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
                        番組名と概要から探します。空白区切りは<strong>すべて含む</strong>もの
                    </span>
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
                                        チャンネルがまだ取り込まれていません。ダッシュボードで「EPGを今すぐ取得」を実行してください。
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
                        <!-- EPG のジャンルは大分類だけで判定する。中分類まで求めると
                             局によって付け方がまちまちで取りこぼす -->
                        <div class="grid gap-x-4 gap-y-1 sm:grid-cols-2" data-testid="rule-genres">
                            {#each GENRE_OPTIONS as option (option.value)}
                                <label class="flex cursor-pointer items-center gap-2">
                                    <input
                                        type="checkbox"
                                        name="genres"
                                        value={option.value}
                                        checked={seedGenres.includes(option.value)}
                                        class="checkbox checkbox-sm"
                                    />
                                    <span class="truncate text-sm">{option.label}</span>
                                </label>
                            {/each}
                        </div>
                    </div>
                </details>
            </div>

            <fieldset class="border-base-300 rounded-box border p-4">
                <legend class="px-2 text-sm font-medium">録画のしかた</legend>
                <div class="grid gap-4 lg:grid-cols-4">
                    <label class="flex flex-col gap-1">
                        <span class="text-sm font-medium">映像コーデック</span>
                        <select name="codec" class="select select-bordered w-full" data-testid="rule-codec">
                            <option value="av1" selected={(data.seed?.codec ?? 'av1') === 'av1'}>
                                AV1 (小さい・遅い)
                            </option>
                            <option value="h264" selected={data.seed?.codec === 'h264'}>
                                H.264 (速い・非力なマシン向け)
                            </option>
                        </select>
                    </label>
                    <label class="flex flex-col gap-1">
                        <span class="text-sm font-medium">CM</span>
                        <select name="cmCut" class="select select-bordered w-full" data-testid="rule-cmcut">
                            <option value="chapter" selected={(data.seed?.cm_cut ?? 'chapter') === 'chapter'}>
                                チャプターだけ (安全)
                            </option>
                            <option value="cut" selected={data.seed?.cm_cut === 'cut'}>
                                実際に切る (字幕は落ちる)
                            </option>
                            <option value="off" selected={data.seed?.cm_cut === 'off'}>何もしない</option>
                        </select>
                    </label>
                    <div class="flex flex-col justify-center gap-2 lg:col-span-2">
                        <div class="grid gap-2 sm:grid-cols-3">
                            <label class="flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="encode"
                                    class="checkbox checkbox-sm"
                                    checked={data.seed ? data.seed.encode === 1 : true}
                                />
                                <span class="text-sm">エンコードする</span>
                            </label>
                            <label class="flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="keepOriginal"
                                    class="checkbox checkbox-sm"
                                    checked={data.seed ? data.seed.keep_original === 1 : false}
                                />
                                <span class="text-sm">生TSも残す</span>
                            </label>
                            <label class="flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="freeOnly"
                                    class="checkbox checkbox-sm"
                                    checked={data.seed ? data.seed.free_only === 1 : true}
                                />
                                <span class="text-sm">無料放送のみ</span>
                            </label>
                        </div>
                    </div>
                </div>
            </fieldset>

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
    </div>
</div>

{#if data.preview}
    <div class="card bg-base-100 mb-6 shadow" data-testid="preview">
        <div class="card-body">
            <h2 class="card-title text-base">
                この条件で録れる番組は {data.preview.total} 件
                {#if data.preview.total > data.preview.programs.length}
                    <span class="text-base-content/60 text-sm font-normal">
                        (先頭 {data.preview.programs.length} 件)
                    </span>
                {/if}
            </h2>
            {#if data.preview.total === 0}
                <p class="text-base-content/60 text-sm">
                    いまの番組表では1件も当たりません。条件を緩めてください。
                </p>
            {:else}
                <ul class="space-y-1" data-testid="preview-list">
                    {#each data.preview.programs as program (program.id)}
                        <li class="text-sm" data-testid="preview-row">
                            <span class="text-base-content/60">{dateTime(program.start_at)}</span>
                            <span class="text-base-content/60">{program.service_name}</span>
                            {program.name}
                            {#if program.reservation_state}
                                <span class="badge badge-sm badge-info">予約済み</span>
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
                <th>録画</th>
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
                    </td>
                    <td class="text-error text-sm">{rule.ignore_keyword || '-'}</td>
                    <td class="max-w-xs truncate text-sm">{describe(rule)}</td>
                    <td class="text-sm whitespace-nowrap">
                        <span class="badge badge-sm badge-ghost" data-testid="rule-codec-badge">
                            {rule.codec.toUpperCase()}
                        </span>
                        <span class="badge badge-sm badge-ghost" data-testid="rule-cmcut-badge">
                            CM: {CM_LABEL[rule.cm_cut]}
                        </span>
                    </td>
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
