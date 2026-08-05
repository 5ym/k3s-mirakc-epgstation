<!--
    ログアウトしたことを出すだけの画面。

    `/` へ戻すと SSO が効いている間は黙って入り直してしまい、出られたのかどうかが
    画面から読めない。ここで一度止めて、入り直すかどうかを人に決めさせる。
-->
<div class="flex min-h-[60vh] items-center justify-center p-4">
    <div class="card bg-base-100 w-full max-w-sm shadow">
        <div class="card-body items-center text-center">
            <h1 class="card-title">ログアウトしました</h1>
            <p class="text-base-content/60 text-sm">
                この端末の控えは消しました。Microsoft からは出ていないので、
                入り直すときはパスワードを聞かれないことがあります。
            </p>
            <div class="card-actions mt-2">
                <a class="btn btn-primary" href="/login">もう一度ログイン</a>
            </div>
        </div>
    </div>
</div>
