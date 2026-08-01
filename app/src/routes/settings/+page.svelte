<script lang="ts">
    import { submitting } from '$lib/actions';
    import { EVENT_LABEL } from '$lib/webhook-events';
    import { dateTime } from '$lib/format';

    let { data, form } = $props();

    // 引き継ぎは数百GBのコピーになる。進み具合はサーバから push される
</script>

<h1 class="mb-4 text-2xl font-bold">設定</h1>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="settings-error">{form.message}</div>
{/if}

{#if form?.saved}
    <div class="alert alert-success mb-4" data-testid="saved-result">保存しました。</div>
{/if}

<section class="card bg-base-100 mb-6 shadow">
    <div class="card-body">
        <h2 class="card-title">録画のしかた</h2>
        <p class="text-base-content/70 text-sm">
            全部の録画に効きます。番組ごとに変えたくなることは実際にはほとんど無いので、
            ルールにも予約にも同じ選択肢を並べず、ここ1箇所で決めます。
        </p>
        <form method="POST" action="?/saveRecording" use:submitting class="grid gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1">
                <span class="text-sm font-medium">映像コーデック</span>
                <select name="codec" class="select select-bordered w-full" data-testid="global-codec">
                    <option value="av1" selected={data.recording.codec === 'av1'}>
                        AV1 (小さい・遅い)
                    </option>
                    <option value="h264" selected={data.recording.codec === 'h264'}>
                        H.264 (速い・非力なマシン向け)
                    </option>
                </select>
                {#if data.fromEnv.codec}
                    <span class="text-base-content/60 text-xs">いまは環境変数の値です</span>
                {/if}
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-sm font-medium">CM</span>
                <select name="cmCut" class="select select-bordered w-full" data-testid="global-cmcut">
                    <option value="chapter" selected={data.recording.cmCut === 'chapter'}>
                        チャプターを打つだけ (安全)
                    </option>
                    <option value="cut" selected={data.recording.cmCut === 'cut'}>実際に切る</option>
                    <option value="off" selected={data.recording.cmCut === 'off'}>何もしない</option>
                </select>
                {#if data.fromEnv.cmCut}
                    <span class="text-base-content/60 text-xs">いまは環境変数の値です</span>
                {/if}
            </label>
            <div class="sm:col-span-2">
                <button class="btn btn-primary" data-testid="save-recording">保存</button>
            </div>
        </form>
    </div>
</section>

<section class="card bg-base-100 mb-6 shadow">
    <div class="card-body">
        <h2 class="card-title">ベーシック認証</h2>
        <p class="text-base-content/70 text-sm">
            mpv も Kodi も、画面の前段に置くリダイレクト型の認証を扱えません。
            ファイルを取りに来る口だけにベーシック認証をかけられます。 ユーザー名とパスワードの<strong
                >両方</strong
            >が入っているときだけ有効です。
        </p>
        <form method="POST" action="?/saveAuth" use:submitting class="grid gap-4 sm:grid-cols-3">
            <label class="flex flex-col gap-1">
                <span class="text-sm font-medium">ユーザー名</span>
                <input
                    name="basicAuthUser"
                    class="input input-bordered w-full"
                    value={data.auth.user}
                    data-testid="auth-user"
                />
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-sm font-medium">パスワード</span>
                <input
                    type="password"
                    name="basicAuthPassword"
                    class="input input-bordered w-full"
                    placeholder={data.auth.hasPassword ? '設定済み (変えるときだけ入力)' : ''}
                    data-testid="auth-password"
                />
            </label>
            <label class="flex flex-col gap-1">
                <span class="text-sm font-medium">適用範囲</span>
                <select name="basicAuthScope" class="select select-bordered w-full" data-testid="auth-scope">
                    <option value="files" selected={data.auth.scope === 'files'}> 配信と WebDAV だけ </option>
                    <option value="all" selected={data.auth.scope === 'all'}>画面も含めて全部</option>
                </select>
            </label>
            <div class="sm:col-span-3">
                {#if data.auth.scope === 'files' && data.auth.hasPassword}
                    <div class="alert alert-warning mb-3" data-testid="auth-warning">
                        この範囲だと録画一覧の画面には認証がかかりません。再生リンクのURLに
                        パスワードを埋めているので、画面を開ければパスワードも見えます。
                        画面の前段に別の認証がある前提の設定です。
                    </div>
                {/if}
                <button class="btn btn-primary" data-testid="save-auth">保存</button>
            </div>
        </form>
    </div>
</section>

<section class="card bg-base-100 shadow">
    <div class="card-body">
        <h2 class="card-title">通知</h2>
        <p class="text-base-content/70 text-sm">
            録画の節目を外部に飛ばします。Discord や Slack の Incoming Webhook の URL をそのまま入れられます。
            録画の失敗は画面を開くまで気づけないので、少なくとも失敗だけでも入れておくと安心です。
        </p>

        {#if form?.tested}
            <div class="alert mb-2" data-testid="webhook-tested">テスト送信の結果: {form.tested}</div>
        {/if}

        <form method="POST" action="?/addWebhook" use:submitting class="grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 sm:col-span-2">
                <span class="text-sm font-medium">URL</span>
                <input
                    name="url"
                    class="input input-bordered w-full"
                    placeholder="https://..."
                    data-testid="webhook-url"
                />
            </label>
            <div class="sm:col-span-2">
                <span class="text-sm font-medium">送る通知</span>
                <div class="mt-1 flex flex-wrap gap-4" data-testid="webhook-events">
                    {#each data.events as event (event)}
                        <label class="flex cursor-pointer items-center gap-2">
                            <input type="checkbox" name="events" value={event} class="checkbox checkbox-sm" />
                            <span class="text-sm">{EVENT_LABEL[event]}</span>
                        </label>
                    {/each}
                </div>
                <p class="text-base-content/60 mt-1 text-xs">1つも選ばなければ全部送ります</p>
            </div>
            <div class="sm:col-span-2">
                <button class="btn btn-primary" data-testid="webhook-add">追加</button>
            </div>
        </form>

        {#if data.webhooks.length > 0}
            <div class="mt-4 overflow-x-auto">
                <table class="table-zebra table">
                    <thead>
                        <tr>
                            <th>URL</th>
                            <th>送る通知</th>
                            <th>直近の結果</th>
                            <th class="w-56"></th>
                        </tr>
                    </thead>
                    <tbody data-testid="webhook-list">
                        {#each data.webhooks as webhook (webhook.id)}
                            <tr data-testid="webhook-row" data-webhook-id={webhook.id}>
                                <td class="max-w-md">
                                    <div class="truncate font-mono text-xs">{webhook.url}</div>
                                    <span
                                        class="badge badge-sm {webhook.enabled
                                            ? 'badge-success'
                                            : 'badge-ghost'}"
                                    >
                                        {webhook.enabled ? '有効' : '無効'}
                                    </span>
                                </td>
                                <td class="text-sm">
                                    {JSON.parse(webhook.events).length === 0
                                        ? 'すべて'
                                        : JSON.parse(webhook.events)
                                              .map((e: string) => EVENT_LABEL[e] ?? e)
                                              .join(', ')}
                                </td>
                                <td class="text-sm">
                                    {#if webhook.last_sent_at}
                                        <span class={webhook.last_status === 'ok' ? '' : 'text-error'}>
                                            {webhook.last_status}
                                        </span>
                                        <span class="text-base-content/60 block text-xs">
                                            {dateTime(webhook.last_sent_at)}
                                        </span>
                                    {:else}
                                        <span class="text-base-content/60">未送信</span>
                                    {/if}
                                </td>
                                <td class="flex flex-wrap gap-2">
                                    <form method="POST" action="?/testWebhook" use:submitting>
                                        <input type="hidden" name="id" value={webhook.id} />
                                        <button class="btn btn-xs" data-testid="webhook-test"
                                            >テスト送信</button
                                        >
                                    </form>
                                    <form method="POST" action="?/toggleWebhook" use:submitting>
                                        <input type="hidden" name="id" value={webhook.id} />
                                        <button class="btn btn-xs" data-testid="webhook-toggle">
                                            {webhook.enabled ? '無効化' : '有効化'}
                                        </button>
                                    </form>
                                    <form method="POST" action="?/deleteWebhook" use:submitting>
                                        <input type="hidden" name="id" value={webhook.id} />
                                        <button
                                            class="btn btn-xs btn-error btn-outline"
                                            data-testid="webhook-delete"
                                        >
                                            削除
                                        </button>
                                    </form>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </div>
</section>
