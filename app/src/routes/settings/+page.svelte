<script lang="ts">
    import { enhance } from '$app/forms';

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

<div class="grid gap-6 lg:grid-cols-2">
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

            <form method="POST" action="?/issue" use:enhance class="space-y-3">
                <label class="form-control">
                    <span class="label-text">Jellyfin のURL</span>
                    <input
                        name="jellyfinUrl"
                        value={data.jellyfinUrl}
                        placeholder="http://jellyfin:8096"
                        class="input input-bordered w-full"
                        data-testid="jellyfin-url"
                    />
                </label>
                <div class="grid gap-3 sm:grid-cols-2">
                    <label class="form-control">
                        <span class="label-text">管理者ID</span>
                        <input
                            name="username"
                            class="input input-bordered w-full"
                            data-testid="jellyfin-user"
                        />
                    </label>
                    <label class="form-control">
                        <span class="label-text">パスワード</span>
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

            <form method="POST" action="?/save" use:enhance class="space-y-3">
                <input type="hidden" name="jellyfinUrl" value={data.jellyfinUrl} />
                <label class="form-control">
                    <span class="label-text">APIキーを直接貼る</span>
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
            <form method="POST" action="?/setup" use:enhance class="mt-2">
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
