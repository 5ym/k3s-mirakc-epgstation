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
</script>

<h1 class="mb-4 text-2xl font-bold">自動予約ルール</h1>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="rule-error">{form.message}</div>
{/if}

<div class="card bg-base-100 mb-6 shadow">
    <div class="card-body">
        <h2 class="card-title">ルールを追加</h2>
        <form method="POST" action="?/create" use:enhance class="grid gap-4 md:grid-cols-2">
            <label class="form-control">
                <span class="label-text">ルール名</span>
                <input name="name" class="input input-bordered" data-testid="rule-name" required />
            </label>
            <label class="form-control">
                <span class="label-text">キーワード (空白区切りでAND)</span>
                <input name="keyword" class="input input-bordered" data-testid="rule-keyword" />
            </label>
            <label class="form-control">
                <span class="label-text">除外キーワード (空白区切りでOR)</span>
                <input name="ignoreKeyword" class="input input-bordered" data-testid="rule-ignore" />
            </label>
            <label class="form-control">
                <span class="label-text">チャンネル (未選択で全局)</span>
                <select
                    name="serviceIds"
                    multiple
                    size="4"
                    class="select select-bordered h-auto"
                    data-testid="rule-services"
                >
                    {#each data.services as service (service.id)}
                        <option value={service.id}>[{service.type}] {service.name}</option>
                    {/each}
                </select>
            </label>
            <div class="flex flex-wrap items-center gap-4">
                <label class="label cursor-pointer gap-2">
                    <input type="checkbox" name="encode" class="checkbox" checked />
                    <span class="label-text">エンコードする</span>
                </label>
                <label class="label cursor-pointer gap-2">
                    <input type="checkbox" name="keepOriginal" class="checkbox" />
                    <span class="label-text">生TSも残す</span>
                </label>
                <label class="label cursor-pointer gap-2">
                    <input type="checkbox" name="freeOnly" class="checkbox" checked />
                    <span class="label-text">無料放送のみ</span>
                </label>
            </div>
            <label class="form-control">
                <span class="label-text">映像コーデック</span>
                <select name="codec" class="select select-bordered" data-testid="rule-codec">
                    <option value="av1" selected>AV1 (小さい・遅い)</option>
                    <option value="h264">H.264 (速い・非力なマシン向け)</option>
                </select>
            </label>
            <label class="form-control">
                <span class="label-text">CM</span>
                <select name="cmCut" class="select select-bordered" data-testid="rule-cmcut">
                    <option value="chapter" selected>チャプターを付けるだけ (安全)</option>
                    <option value="cut">実際に切る (字幕は落ちる)</option>
                    <option value="off">何もしない</option>
                </select>
            </label>
            <label class="form-control">
                <span class="label-text">優先度 (大きいほど優先)</span>
                <input type="number" name="priority" value="2" min="0" max="9" class="input input-bordered" />
            </label>
            <div class="md:col-span-2">
                <button class="btn btn-primary" data-testid="rule-submit">追加</button>
            </div>
        </form>
    </div>
</div>

<div class="mb-2 flex justify-end">
    <form method="POST" action="?/apply" use:enhance>
        <button class="btn btn-sm" data-testid="rule-apply">今すぐ全ルールを適用</button>
    </form>
</div>

<div class="overflow-x-auto rounded-box bg-base-100 shadow">
    <table class="table table-zebra">
        <thead>
            <tr>
                <th>ルール</th>
                <th>条件</th>
                <th>チャンネル</th>
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
                        <div>{rule.keyword || '(条件なし)'}</div>
                        {#if rule.ignore_keyword}
                            <div class="text-error">除外: {rule.ignore_keyword}</div>
                        {/if}
                        <span class="badge badge-sm badge-ghost" data-testid="rule-cmcut-badge">
                            CM: {CM_LABEL[rule.cm_cut]}
                        </span>
                        <span class="badge badge-sm badge-ghost" data-testid="rule-codec-badge">
                            {rule.codec.toUpperCase()}
                        </span>
                    </td>
                    <td class="max-w-xs truncate text-sm">{serviceNames(rule.service_ids)}</td>
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
                <tr><td colspan="5" class="text-base-content/60">ルールはまだありません</td></tr>
            {/each}
        </tbody>
    </table>
</div>
