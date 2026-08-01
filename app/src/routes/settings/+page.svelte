<script lang="ts">
    import { submitting } from '$lib/actions';
    import { EVENT_LABEL } from '$lib/webhook-events';
    import { dateTime } from '$lib/format';

    let { data, form } = $props();
</script>

<h1 class="mb-4 text-2xl font-bold">設定</h1>

{#if form?.message}
    <div class="alert alert-error mb-4" data-testid="settings-error">{form.message}</div>
{/if}
{#if form?.issued}
    <div class="alert alert-success mb-4" data-testid="issued-result">
        APIキーを発行して保存しました。パスワードは保存していません。
    </div>
{/if}
{#if form?.saved}
    <div class="alert alert-success mb-4" data-testid="saved-result">保存しました。</div>
{/if}
{#if form?.setup}
    <div class="alert alert-success mb-4" data-testid="setup-result">
        <div>
            <div>
                ライブラリ「{form.setup.library.name}」を{form.setup.library.created
                    ? '追加'
                    : form.setup.library.renamed
                      ? '名前を変更して更新'
                      : '既存のまま更新'}しました
            </div>
            <div>
                削除を許可: {form.setup.granted.length === 0
                    ? '変更なし(既に許可済み)'
                    : form.setup.granted.join(', ')}
            </div>
            <div>
                ライブTV: チューナー{form.setup.liveTv.tunerAdded ? '追加' : '既存のまま'} / 番組表{form.setup
                    .liveTv.guideAdded
                    ? '追加'
                    : '既存のまま'}
            </div>
        </div>
    </div>
{/if}

<div class="grid items-start gap-6 lg:grid-cols-2">
    <section class="card bg-base-100 shadow">
        <div class="card-body">
            <h2 class="card-title">Jellyfin 接続</h2>
            <p class="text-base-content/70 text-sm">
                APIキーは Jellyfin のセットアップを終えてからでないと作れないので、ここで発行します。
                管理者のIDとパスワードは発行にだけ使い、<strong>パスワードは保存しません</strong>。
            </p>

            <div class="my-2 flex flex-wrap items-center gap-2">
                <span
                    class="badge {data.enabled ? 'badge-success' : 'badge-error'}"
                    data-testid="jellyfin-state"
                >
                    {data.enabled ? '連携済み' : '未設定'}
                </span>
                {#if data.hasApiKey}
                    <span class="badge badge-ghost" data-testid="key-source">
                        APIキー: {data.fromEnv.apiKey ? '環境変数から' : 'この画面で設定'}
                    </span>
                {/if}
            </div>

            <form method="POST" action="?/issue" use:submitting class="space-y-3">
                <label class="flex flex-col gap-1">
                    <span class="text-sm font-medium">Jellyfin のURL</span>
                    <input
                        name="jellyfinUrl"
                        value={data.jellyfinUrl}
                        placeholder="http://jellyfin:8096"
                        class="input input-bordered w-full"
                        data-testid="jellyfin-url"
                    />
                </label>
                <div class="grid gap-3 sm:grid-cols-2">
                    <label class="flex flex-col gap-1">
                        <span class="text-sm font-medium">管理者ID</span>
                        <input
                            name="username"
                            class="input input-bordered w-full"
                            data-testid="jellyfin-user"
                        />
                    </label>
                    <label class="flex flex-col gap-1">
                        <span class="text-sm font-medium">パスワード</span>
                        <input
                            type="password"
                            name="password"
                            class="input input-bordered w-full"
                            data-testid="jellyfin-password"
                        />
                    </label>
                </div>
                <button class="btn btn-primary" data-testid="issue-key">APIキーを発行して保存</button>
            </form>

            <div class="divider text-xs">既にAPIキーがある場合</div>

            <form method="POST" action="?/save" use:submitting class="space-y-3">
                <input type="hidden" name="jellyfinUrl" value={data.jellyfinUrl} />
                <label class="flex flex-col gap-1">
                    <span class="text-sm font-medium">APIキーを直接貼る</span>
                    <input
                        name="jellyfinApiKey"
                        class="input input-bordered w-full"
                        placeholder={data.hasApiKey ? '設定済み (空欄なら変更しない)' : ''}
                        data-testid="jellyfin-apikey"
                    />
                </label>
                <button class="btn" data-testid="save-key">保存</button>
            </form>
        </div>
    </section>

    <section class="card bg-base-100 shadow">
        <div class="card-body">
            <h2 class="card-title">Jellyfin 側のセットアップ</h2>
            <p class="text-base-content/70 text-sm">
                Jellyfin の管理画面で手作業する内容を、まとめて設定します。何度押しても重複しません。
            </p>
            <ul class="list-disc space-y-1 pl-5 text-sm">
                <li>
                    <code>{data.libraryDir}</code> を「番組(Shows)」としてライブラリに追加
                </li>
                <li>メタデータを .nfo から読ませ、インターネット取得を無効化</li>
                <li>管理者に「メディアの削除を許可」を付与</li>
                <li>
                    ライブTVのチューナー(M3U)と番組表(XMLTV)を登録
                    <span class="text-base-content/60 block font-mono text-xs">
                        {data.iptvOrigin}/api/iptv/playlist.m3u?profile={data.liveProfile}
                    </span>
                </li>
            </ul>
            <form method="POST" action="?/setup" use:submitting class="mt-2">
                <button class="btn btn-primary" disabled={!data.enabled} data-testid="run-setup">
                    Jellyfin をセットアップ
                </button>
            </form>
            {#if !data.enabled}
                <p class="text-base-content/60 text-sm">先に接続設定を済ませてください。</p>
            {/if}
        </div>
    </section>
</div>

<section class="card bg-base-100 mt-6 shadow">
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
            <label class="flex flex-col gap-1">
                <span class="text-sm font-medium">名前</span>
                <input
                    name="name"
                    class="input input-bordered w-full"
                    placeholder="例: Discord"
                    data-testid="webhook-name"
                />
            </label>
            <label class="flex flex-col gap-1">
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
                            <th>名前</th>
                            <th>URL</th>
                            <th>送る通知</th>
                            <th>直近の結果</th>
                            <th class="w-56"></th>
                        </tr>
                    </thead>
                    <tbody data-testid="webhook-list">
                        {#each data.webhooks as webhook (webhook.id)}
                            <tr data-testid="webhook-row" data-webhook-id={webhook.id}>
                                <td>
                                    <div class="font-medium">{webhook.name}</div>
                                    <span
                                        class="badge badge-sm {webhook.enabled
                                            ? 'badge-success'
                                            : 'badge-ghost'}"
                                    >
                                        {webhook.enabled ? '有効' : '無効'}
                                    </span>
                                </td>
                                <td class="max-w-xs truncate font-mono text-xs">{webhook.url}</td>
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
