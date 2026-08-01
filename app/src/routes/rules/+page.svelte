<script lang="ts">
    import { enhance } from '$app/forms';
    import { CM_LABEL } from '$lib/format';

    let { data, form } = $props();

    function serviceNames(json: string | null): string {
        if (json === null) return 'すべて';
        try {
            const ids: number[] = JSON.parse(json);
            return ids.map((id) => data.services.find((s) => s.id === id)?.name ?? String(id)).join(', ');
        } catch {
            return 'すべて';
        }
    }

    /** チャンネルは50局以上あるので種別ごとにまとめて出す */
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
        <h2 class="card-title">ルールを追加</h2>
        <p class="text-base-content/70 text-sm">
            条件に合う番組を、これから放送されるぶんから自動で予約します。
        </p>

        <form method="POST" action="?/create" use:enhance class="mt-2 max-w-3xl space-y-5">
            <div class="grid gap-4 sm:grid-cols-2">
                <label class="form-control">
                    <span class="label-text">ルール名</span>
                    <input
                        name="name"
                        class="input input-bordered w-full"
                        placeholder="例: 深夜アニメ"
                        data-testid="rule-name"
                        required
                    />
                </label>
                <label class="form-control">
                    <span class="label-text">キーワード</span>
                    <input
                        name="keyword"
                        class="input input-bordered w-full"
                        placeholder="例: 名探偵"
                        data-testid="rule-keyword"
                    />
                    <span class="label-text-alt text-base-content/60">
                        番組名と概要から探します。空白で区切ると<strong>すべて含む</strong>ものだけが対象
                    </span>
                </label>
                <label class="form-control sm:col-span-2">
                    <span class="label-text">除外キーワード</span>
                    <input
                        name="ignoreKeyword"
                        class="input input-bordered w-full"
                        placeholder="例: 再放送 総集編"
                        data-testid="rule-ignore"
                    />
                    <span class="label-text-alt text-base-content/60">
                        空白で区切ると<strong>どれか1つでも含む</strong>ものを除きます
                    </span>
                </label>
            </div>

            <fieldset class="border-base-300 rounded-box border p-4">
                <legend class="label-text px-2">チャンネル</legend>
                <p class="text-base-content/60 mb-2 text-xs">
                    1つも選ばなければ全局が対象です。キーワードが空のときは、ここでの絞り込みが必須になります。
                </p>
                <div class="max-h-56 space-y-3 overflow-y-auto" data-testid="rule-services">
                    {#each grouped as group (group.type)}
                        <div>
                            <div class="text-base-content/60 mb-1 text-xs font-bold">{group.type}</div>
                            <div class="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                                {#each group.services as service (service.id)}
                                    <label class="flex cursor-pointer items-center gap-2">
                                        <input
                                            type="checkbox"
                                            name="serviceIds"
                                            value={service.id}
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
            </fieldset>

            <fieldset class="border-base-300 rounded-box border p-4">
                <legend class="label-text px-2">録画のしかた</legend>
                <div class="grid gap-4 sm:grid-cols-2">
                    <label class="form-control">
                        <span class="label-text">映像コーデック</span>
                        <select name="codec" class="select select-bordered w-full" data-testid="rule-codec">
                            <option value="av1" selected>AV1 (小さい・エンコードが遅い)</option>
                            <option value="h264">H.264 (速い・非力なマシン向け)</option>
                        </select>
                    </label>
                    <label class="form-control">
                        <span class="label-text">CM</span>
                        <select name="cmCut" class="select select-bordered w-full" data-testid="rule-cmcut">
                            <option value="chapter" selected>チャプターを付けるだけ (安全)</option>
                            <option value="cut">実際に切る (字幕は落ちる)</option>
                            <option value="off">何もしない</option>
                        </select>
                    </label>
                </div>
                <div class="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                    <label class="label cursor-pointer gap-2">
                        <input type="checkbox" name="encode" class="checkbox checkbox-sm" checked />
                        <span class="label-text">エンコードする</span>
                    </label>
                    <label class="label cursor-pointer gap-2">
                        <input type="checkbox" name="keepOriginal" class="checkbox checkbox-sm" />
                        <span class="label-text">生TSも残す</span>
                    </label>
                    <label class="label cursor-pointer gap-2">
                        <input type="checkbox" name="freeOnly" class="checkbox checkbox-sm" checked />
                        <span class="label-text">無料放送のみ</span>
                    </label>
                </div>
            </fieldset>

            <label class="form-control max-w-sm">
                <span class="label-text">優先度</span>
                <input
                    type="number"
                    name="priority"
                    value="2"
                    min="0"
                    max="9"
                    class="input input-bordered w-full"
                    data-testid="rule-priority"
                />
                <span class="label-text-alt text-base-content/60">
                    同じ時間帯にチューナーが足りないとき、<strong>数字が大きいほうを残します</strong>。
                    負けたほうは「競合」になって録画されません。手動予約は 3 で作られます
                </span>
            </label>

            <button class="btn btn-primary" data-testid="rule-submit">追加</button>
        </form>
    </div>
</div>

<div class="mb-2 flex justify-end">
    <form method="POST" action="?/apply" use:enhance>
        <button class="btn btn-sm" data-testid="rule-apply">今すぐ全ルールを適用</button>
    </form>
</div>

<div class="rounded-box bg-base-100 overflow-x-auto shadow">
    <table class="table-zebra table">
        <thead>
            <tr>
                <th>ルール</th>
                <th>条件</th>
                <th>チャンネル</th>
                <th>録画</th>
                <th>優先度</th>
                <th>予約数</th>
                <th class="w-40"></th>
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
                    <td class="text-sm">
                        <div>{rule.keyword || '(キーワードなし)'}</div>
                        {#if rule.ignore_keyword}
                            <div class="text-error">除外: {rule.ignore_keyword}</div>
                        {/if}
                    </td>
                    <td class="max-w-xs truncate text-sm">{serviceNames(rule.service_ids)}</td>
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
                    <td class="flex gap-2">
                        <form method="POST" action="?/toggle" use:enhance>
                            <input type="hidden" name="id" value={rule.id} />
                            <button class="btn btn-sm" data-testid="rule-toggle">
                                {rule.enabled ? '無効化' : '有効化'}
                            </button>
                        </form>
                        <form method="POST" action="?/delete" use:enhance>
                            <input type="hidden" name="id" value={rule.id} />
                            <button class="btn btn-sm btn-error btn-outline" data-testid="rule-delete">
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
