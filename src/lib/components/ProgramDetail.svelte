<script lang="ts">
    import type { Snippet } from 'svelte';
    import { type Audio, audioLabel, type Genre, genreLabel, videoLabel } from '$lib/arib';
    import { cmRanges, dateTime, duration, time } from '$lib/format';
    import type { ProgramDetail } from '$lib/types';

    /**
     * 番組の詳細を出すモーダル。
     *
     * 番組表・予約一覧・録画一覧のどこから開いても同じ見え方にするため、ここに寄せてある。
     * 下に並べるボタンだけは開いた場所で違う(番組表なら予約、一覧なら閉じるだけ)ので
     * snippet で受ける。
     */
    let {
        program,
        onclose,
        error = null,
        cm = null,
        cmNote = null,
        extra,
        actions,
    }: {
        program: ProgramDetail;
        onclose: () => void;
        error?: string | null;
        /** 検出したCM区間 (JSON)。録画から開いたときだけ入る */
        cm?: string | null;
        /** 何を使って検出したか (無音 / join_logo_scp)。判定の当てにできるか分かる */
        cmNote?: string | null;
        /** 開いた場所だけで要るもの (録画ならロゴ位置の指定)。無ければ何も出ない */
        extra?: Snippet;
        actions?: Snippet;
    } = $props();

    /** 詳細情報。mirakc が拾った「出演者」などの見出し付きテキスト */
    function extended(json: string | null): [string, string][] {
        if (json === null || json === '') return [];
        try {
            return Object.entries(JSON.parse(json) as Record<string, string>);
        } catch {
            return [];
        }
    }

    /** JSON で持っている列を読む。取り込みの時期によっては入っていないので空で返す */
    function parse<T>(json: string | null): T[] {
        if (json === null || json === '') return [];
        try {
            const value = JSON.parse(json);
            return Array.isArray(value) ? (value as T[]) : [];
        } catch {
            return [];
        }
    }

    const genres = $derived(
        parse<Genre>(program.genre_detail)
            .map(genreLabel)
            .filter((label) => label !== ''),
    );
    const audios = $derived(parse<Audio>(program.audios).map(audioLabel));
    const video = $derived(videoLabel(program.video_resolution, program.video_type));
    const cmText = $derived(cmRanges(cm));
</script>

<div class="modal modal-open" role="dialog" data-testid="program-detail">
    <div class="modal-box max-w-2xl">
        <h3 class="text-lg font-bold">{program.name}</h3>
        <p class="text-base-content/60 mt-1 text-sm">
            {program.service_name} ・ {dateTime(program.start_at)} 〜 {time(program.end_at)}
            ({duration(program.start_at, program.end_at)})
        </p>

        <!-- EPG が持っている符号は、そのままでは読めないので言葉に直して出す -->
        <div class="mt-2 flex flex-wrap gap-1" data-testid="detail-badges">
            {#each genres as label (label)}
                <span class="badge badge-sm badge-ghost" data-testid="detail-genre">{label}</span>
            {/each}
            {#if video}
                <span class="badge badge-sm badge-ghost" data-testid="detail-video">{video}</span>
            {/if}
            {#each audios as label, i (i)}
                <span class="badge badge-sm badge-ghost" data-testid="detail-audio">{label}</span>
            {/each}
            {#if !program.is_free}
                <span class="badge badge-sm badge-warning" data-testid="detail-paid">有料</span>
            {/if}
        </div>

        {#if program.description}
            <p class="mt-3 text-sm whitespace-pre-wrap">{program.description}</p>
        {/if}

        {#each extended(program.extended) as [heading, body] (heading)}
            <div class="mt-3">
                <div class="text-sm font-medium">{heading}</div>
                <div class="text-base-content/70 text-sm whitespace-pre-wrap">{body}</div>
            </div>
        {/each}

        {#if cmText || cmNote}
            <!-- どこをCMとみなしたか。一覧に出すと長くて場所を食うので、見たいときだけ -->
            <div class="mt-3" data-testid="detail-cm">
                <div class="text-sm font-medium">CM</div>
                {#if cmNote}
                    <div class="text-base-content/60 text-xs" data-testid="detail-cm-note">{cmNote}</div>
                {/if}
                <div class="text-base-content/70 text-sm break-words">{cmText}</div>
            </div>
        {/if}

        {#if error}
            <!-- エンコードが失敗した理由。一覧には「失敗」とだけ出して、中身はここで見せる -->
            <div class="mt-3" data-testid="detail-error">
                <div class="text-error text-sm font-medium">エンコードに失敗しました</div>
                <pre
                    class="bg-base-200 mt-1 max-h-48 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">{error}</pre>
            </div>
        {/if}

        {#if extra}
            {@render extra()}
        {/if}

        {#if actions}
            {@render actions()}
        {:else}
            <div class="modal-action">
                <button class="btn" onclick={onclose} data-testid="detail-close">閉じる</button>
            </div>
        {/if}
    </div>
    <button class="modal-backdrop" onclick={onclose} aria-label="閉じる"></button>
</div>
