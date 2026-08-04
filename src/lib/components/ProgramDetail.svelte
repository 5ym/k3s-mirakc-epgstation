<script lang="ts">
    import type { Snippet } from 'svelte';
    import { type Audio, audioLabel, type Genre, genreLabel, videoLabel } from '$lib/arib';
    import { dateTime, duration, linkify, time } from '$lib/format';
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
        notes = [],
        cmNote = null,
        extra,
        actions,
    }: {
        program: ProgramDetail;
        onclose: () => void;
        /**
         * 失敗や削除の理由。一覧には状態だけを出して、中身はここで見せる。
         *
         * 見出しを一緒に渡す。録画そのものの失敗とエンコードの失敗は別物で、
         * どちらも「エンコードに失敗しました」と書いていた頃は、録画が失敗した
         * 行を開くと嘘の見出しが出ていた
         */
        notes?: { title: string; text: string }[];
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
</script>

<!--
    説明文。中に書かれたURLはリンクにする。
    `{@html}` は使わない。EPG の文面は放送局が書いたものをそのまま持ってきているので、
    そのまま流し込めるものとして扱わない
-->
{#snippet body(text: string)}{#each linkify(text) as part, i (i)}{#if part.href}<a
                class="link link-primary break-all"
                href={part.href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="detail-link">{part.text}</a
            >{:else}{part.text}{/if}{/each}{/snippet}

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
            <p class="mt-3 text-sm whitespace-pre-wrap">{@render body(program.description)}</p>
        {/if}

        {#each extended(program.extended) as [heading, text] (heading)}
            <div class="mt-3">
                <div class="text-sm font-medium">{heading}</div>
                <div class="text-base-content/70 text-sm whitespace-pre-wrap">{@render body(text)}</div>
            </div>
        {/each}

        {#if cmNote}
            <!--
                **いつもの精度が出なかったときだけ出す。** ロゴまで見て判定できた回は
                `cmNote` ごと渡ってこない (`format.cmNoteWorthShowing`) ので、この塊は
                出ない。「join_logo_scp」とだけ書いてあっても読む人には何の情報にもならず、
                結果はチャプターを見れば分かる。ここに何か書いてあること自体が合図になる。

                **どこを切ったかは書かない** — 切った位置はチャプターとして動画に
                入っている。時刻を並べていた頃は、長い一覧が説明文の下を埋めていた。

                ロゴを教える口を出すかどうかも、この文言から決めている
                (`format.logoUnusable`)。その口 (LogoArea) はこのすぐ下に続くので、
                **あちらに見出しは付けない** — 同じことを2回読ませないため
            -->
            <div class="mt-3" data-testid="detail-cm">
                <div class="text-sm font-medium">CM</div>
                <div class="text-base-content/60 text-xs" data-testid="detail-cm-note">{cmNote}</div>
            </div>
        {/if}

        <!--
            ロゴの位置を教える口。**CM の覚え書きのすぐ下に置く。**
            失敗の理由 (下) を挟んでいた頃は、上の「jls は使えず…」と離れてしまい、
            見出しが無いと何の話か分からなくなっていた
        -->
        {#if extra}
            {@render extra()}
        {/if}

        {#each notes as note (note.title)}
            <!-- 失敗や削除の理由。一覧には状態だけを出して、中身はここで見せる -->
            <div class="mt-3" data-testid="detail-error">
                <div class="text-error text-sm font-medium">{note.title}</div>
                <pre
                    class="bg-base-200 mt-1 max-h-48 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap">{note.text}</pre>
            </div>
        {/each}

        <!--
            **枠はこちらで持つ。** 渡す側に任せていた頃は、フォームが行を占める
            箱なので押すものが縦に積み上がり、左端に寄っていた。
            `modal-action` は右下に横並びなので、どこから開いても同じ形になる。
            **閉じるはいちばん右。** 並びの終わりがいつも同じところにあると、
            見ないでも押せる
        -->
        <div class="modal-action">
            {#if actions}
                {@render actions()}
            {:else}
                <button class="btn" onclick={onclose} data-testid="detail-close">閉じる</button>
            {/if}
        </div>
    </div>
    <button class="modal-backdrop" onclick={onclose} aria-label="閉じる"></button>
</div>
