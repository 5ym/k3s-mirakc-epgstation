<script lang="ts">
    import { enhance } from '$app/forms';
    import { dateTime, duration, stateLabel, badgeClass } from '$lib/format';

    let { data, form } = $props();
</script>

<div class="mb-4 flex items-center justify-between">
    <h1 class="text-2xl font-bold">予約</h1>
    <div class="flex gap-2">
        <a class="btn btn-sm" href={data.showFinished ? '/reservations' : '/reservations?all=1'}>
            {data.showFinished ? '進行中のみ' : '完了分も表示'}
        </a>
        {#if data.jellyfin}
            <form method="POST" action="?/importTimers" use:enhance>
                <button class="btn btn-sm" data-testid="import-timers">Jellyfinの録画予約を取り込む</button>
            </form>
        {/if}
        <form method="POST" action="?/resolve" use:enhance>
            <button class="btn btn-sm">競合を再計算</button>
        </form>
    </div>
</div>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="reservation-error">{form.message}</div>
{/if}
{#if form?.timers}
    <div class="alert alert-info mb-4" data-testid="import-result">
        取り込み {form.timers.imported} 件 / 対象外 {form.timers.skipped} 件 / 失敗 {form.timers.failed} 件
        {#each form.timers.messages as message}<span class="ml-2 text-sm">{message}</span>{/each}
    </div>
{/if}

<div class="overflow-x-auto rounded-box bg-base-100 shadow">
    <table class="table table-zebra">
        <thead>
            <tr>
                <th>放送日時</th>
                <th>チャンネル</th>
                <th>番組</th>
                <th>種別</th>
                <th>状態</th>
                <th class="w-28"></th>
            </tr>
        </thead>
        <tbody data-testid="reservation-list">
            {#each data.reservations as res (res.id)}
                <tr
                    data-testid="reservation-row"
                    data-reservation-id={res.id}
                    data-program-id={res.program_id}
                >
                    <td class="whitespace-nowrap">
                        {dateTime(res.start_at)}
                        <span class="text-base-content/60 text-xs">
                            ({duration(res.start_at, res.end_at)})
                        </span>
                    </td>
                    <td class="whitespace-nowrap">{res.service_name}</td>
                    <td>
                        <div class="font-medium">{res.name}</div>
                        {#if res.conflict_reason}
                            <div class="text-error text-sm">{res.conflict_reason}</div>
                        {/if}
                    </td>
                    <td class="whitespace-nowrap text-sm">
                        {res.manual ? '手動' : (res.rule_name ?? 'ルール')}
                        {#if !res.encode}<span class="badge badge-ghost badge-sm">TSのみ</span>{/if}
                    </td>
                    <td>
                        <span class="badge {badgeClass(res.state)}" data-testid="reservation-state">
                            {stateLabel(res.state)}
                        </span>
                    </td>
                    <td>
                        {#if ['scheduled', 'conflict', 'recording'].includes(res.state)}
                            <form method="POST" action="?/cancel" use:enhance>
                                <input type="hidden" name="id" value={res.id} />
                                <button class="btn btn-sm btn-error btn-outline" data-testid="cancel-button">
                                    取消
                                </button>
                            </form>
                        {/if}
                    </td>
                </tr>
            {:else}
                <tr><td colspan="6" class="text-base-content/60">予約はありません</td></tr>
            {/each}
        </tbody>
    </table>
</div>
