<script lang="ts">
    import { enhance } from '$app/forms';
    import { dateTime, duration, stateLabel, badgeClass } from '$lib/format';

    let { data, form } = $props();
</script>

<h1 class="mb-4 text-2xl font-bold">番組表</h1>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="guide-error">{form.message}</div>
{/if}

<form method="GET" class="mb-4 flex flex-wrap items-end gap-2" data-testid="guide-filter">
    <label class="form-control">
        <span class="label-text">チャンネル</span>
        <select name="service" class="select select-bordered" data-testid="filter-service">
            <option value="">すべて</option>
            {#each data.services as service (service.id)}
                <option value={service.id} selected={service.id === data.serviceId}>
                    [{service.type}] {service.name}
                </option>
            {/each}
        </select>
    </label>
    <label class="form-control">
        <span class="label-text">キーワード</span>
        <input
            type="search"
            name="q"
            value={data.keyword}
            class="input input-bordered"
            data-testid="filter-keyword"
        />
    </label>
    <button class="btn btn-primary" type="submit">絞り込む</button>
</form>

<div class="overflow-x-auto rounded-box bg-base-100 shadow">
    <table class="table table-zebra">
        <thead>
            <tr>
                <th>放送日時</th>
                <th>チャンネル</th>
                <th>番組</th>
                <th class="w-32"></th>
            </tr>
        </thead>
        <tbody data-testid="program-list">
            {#each data.programs as program (program.id)}
                <tr data-testid="program-row" data-program-id={program.id}>
                    <td class="whitespace-nowrap">
                        {dateTime(program.start_at)}
                        <span class="text-base-content/60 text-xs">
                            ({duration(program.start_at, program.end_at)})
                        </span>
                    </td>
                    <td class="whitespace-nowrap">{program.service_name}</td>
                    <td>
                        <div class="font-medium">{program.name}</div>
                        <div class="text-base-content/60 line-clamp-1 text-sm">{program.description}</div>
                    </td>
                    <td>
                        {#if program.reservation_state}
                            <span class="badge {badgeClass(program.reservation_state)}">
                                {stateLabel(program.reservation_state)}
                            </span>
                        {:else}
                            <form method="POST" action="?/reserve" use:enhance>
                                <input type="hidden" name="programId" value={program.id} />
                                <button class="btn btn-sm btn-primary" data-testid="reserve-button">
                                    予約
                                </button>
                            </form>
                        {/if}
                    </td>
                </tr>
            {:else}
                <tr><td colspan="4" class="text-base-content/60">番組がありません</td></tr>
            {/each}
        </tbody>
    </table>
</div>
