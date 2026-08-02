# 開発する

**ホストに bun は入れません。全部コンテナの中で動かします。**
実チューナーも B-CASカードも ffmpeg も要りません。

```sh
docker compose up                           # 開発サーバ(:5173) + 偽mirakc(:40772)
docker compose run --rm unit                # 単体テスト
docker compose run --rm e2e                 # E2E (Playwright)
docker compose run --rm unit bun run lint   # リント + フォーマット確認
docker compose run --rm unit bun run format # フォーマット適用
docker compose run --rm unit bun run check  # 型 (svelte-check)
```

依存を足したら `docker compose run --rm unit bun install` を一度回してください
(`node_modules` は名前付きボリュームなので、イメージの焼き直しは要りません)。

## テストの方針

**E2E が主で、単体テストは純粋関数の境界条件だけ。** 偽mirakc・偽の通知先・
偽ffmpeg を立てて、予約から録画・CM検出・エンコード・保存先への配置・
視聴済み削除までを実際に通します (`tests/fake/`)。偽mirakc は1番組10秒にしてあるので、
録画完了まで待っても30秒で終わります。

画面まわりの入口は [app.md](app.md#テスト)、置いてあるものの一覧は
[app.md](app.md#構成) にあります。

### 並べて流す

**ワーカーごとに denpa と偽mirakc と偽通知先を1式ずつ立てます** (`tests/stack.ts`)。
ポートも置き場もDBも別なので、同時に走っているファイル同士は互いに見えません。

1つのアプリとDBを共有していた頃は直列に流すしかありませんでした。予約もルールも
同じ表に入るので、2つのテストが同時に動くと件数が合いません。分けたことで
**2分半が1分**になっています。

- ファイルの中は今までどおり順番 (`fullyParallel: false`)。1つのファイルの中では
  前のテストが作った予約や録画を次が当てにしている書き方があります
- **ファイルをまたいで当てにはできません。** 別のワーカーに割り振られたら
  そこには何もありません。実体のある録画が要るテストは `recordOne()` で自分のぶんを録ります
- アプリは開発サーバではなく**組んだもの** (`bun run build` → `adapter-node`) を
  ワーカーの数だけ動かします。開発サーバを4つ立てるより軽く、本番と同じ出力を試せます
- API から直接投げるときは `Origin` を付けています。SvelteKit はフォーム形式の POST を
  Origin で見ていて、付いていないものを別サイトからの送信として断るためです

## 再生の受け口 (Windows / Mac)

`denpa://` を登録する側は、**壊れていても OS が黙って何もしないだけ**という
一番わかりにくい壊れ方をします。どちらも Windows / Mac でなくても確かめられる
検証スクリプトを付けてあるので、触ったら必ず通してください。

```sh
docker run --rm -v "$PWD/windows:/w:ro" mcr.microsoft.com/powershell:latest \
    pwsh -NoProfile -File /w/verify.ps1
sh mac/verify.sh
```

`verify.ps1` は、レジストリに入れる1行が **Windows の引数分解 (CommandLineToArgvW) を
通っても欠けないこと**まで見ます。`-Command "..."` の中に二重引用符が1つでもあると
そこで値が打ち切られ、PowerShell は残りを空白で繋いで動かしてしまうので、
構文エラーも出ないまま「番組名がくくられていない」状態だけが残ります。
`denpa.ps1` の中で二重引用符を書かず `$q` を組み立てているのはこのためです。

`verify.sh` は `curl … | sh` で流し込まれた場合 (自分の場所が分からない状態) も
見ています。

> `.ps1` は **UTF-8 BOM 付き + CRLF** で置いてあります。PowerShell 5.1 は BOM が
> 無いと ANSI (日本語環境では CP932) として読み、CP932 の先行バイトが次の ASCII 文字を
> 巻き込むので `'` や `}` が消えて構文エラーになります。`.gitattributes` で保っています。
> WSL のパスから直接実行すると「セキュリティの警告」が出ます。

> **Mac は実機での確認が取れていません。** `verify.sh` が見ているのはリンクの処理までで、
> アプレットの組み立てと登録 (`osacompile` / `PlistBuddy` / `lsregister`) は
> macOS がないと走らせられません。

## イメージ

`Dockerfile` が denpa 本体、`mirakc/` がチューナー側 (mirakc + スキャン用の
エージェント) です。CI が両方を焼いて `k3s/` のタグを書き戻します。

## もっと詳しく

- [architecture.md](architecture.md) — **なぜこの形なのか**
- [app.md](app.md) — **どこに何があるか** (ファイル・環境変数・画面・状態遷移)
- [data.md](data.md) — mirakc に都度聞くもの / denpa が持つもの
