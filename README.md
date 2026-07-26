# k3s epg

このディレクトリには EPG スタックの k3s マニフェストとローカルファイルが置かれています。

## チャンネルスキャン

- Mirakurunの Web UI (`http://<host>:40772/`) → 「チャンネル設定」画面右上の
  **Channel Scan** から、`Channel Type`(GR/BS/CS) と `Min/Max Channel` を
  指定してスキャンできます。実機のチューナーで受信状況を見ながら現在使える
  チャンネルを検出する機能です。既存のチャンネル一覧を更新する形にするため
  **Refresh (Update existing channels)** を有効にして実行してください。
- 目視での転記はミスの元なので、`kubectl cp` でスキャン後のファイルを
  そのまま取り出してリポジトリに上書きするのがおすすめです。

  ```sh
  kubectl -n epg cp \
    "$(kubectl -n epg get pod -l app=mirakurun -o jsonpath='{.items[0].metadata.name}'):/app-config/channels.yml" \
    ./mirakurun/channels.yml
  ```

  `git diff` で意図しない変更が無いか確認してからcommit・pushしてください。
  `build-and-deploy.yml` が `mirakurun/*.yml` の変更を検知してイメージを
  再ビルド・再デプロイします。

## Windows でのVLC視聴

- `vlc/` 以下は、EPGStationのWeb UIにある視聴/ダウンロードリンク
  (`cvlc://user:...@ADDRESS` 形式。`epgstation/config.template.yml` の
  `urlscheme` 参照)をWindows上でクリックしたときにVLCが直接起動して
  再生されるようにするための設定一式です。
- `install-vlc-protocol.ps1`: `cvlc://` プロトコルをレジストリに登録し、
  ハンドラとして `%USERPROFILE%\OneDrive\Tool\vlc.bat` を呼び出す
  ように設定します(REG_EXPAND_SZ で登録しているので `%USERPROFILE%` は
  環境ごとに自動展開されます)。視聴用PCの `OneDrive\Tool\` 以下に
  `vlc.bat` を配置してから実行してください。管理者権限が必要ですが、
  スクリプト自身が非管理者で起動された場合はUACプロンプトを出して
  自動的に昇格・再実行するので、右クリック→「Run with PowerShell」で
  そのまま実行してかまいません。配置先を変える場合はスクリプト内の
  パスも書き換えが必要です。
- `vlc.bat`: 渡された `cvlc://...` のURLから `https://...` を組み立てて
  `C:\Program Files\VideoLAN\VLC\vlc.exe` を起動します。VLCのインストール
  先が異なる場合はパスを書き換えてください。
- `uninstall-vlc-protocol.ps1`: 登録した `cvlc` プロトコルの削除用です。

## 補足

- Mirakurunの設定は `mirakurun/server.yml`/`tuners.yml`/`channels.yml` の3
  ファイルで管理しています。epgstationの `config.template.yml` と同様に
  Docker イメージの `/app-config` へそのまま焼き込まれ、PVCなどによる永続化は
  していません(pod再起動のたびにイメージ内の内容で作り直されます)。
  サービスIDの解決結果や番組表そのものは `/app-data` (下記) に保存される
  ため、`channels.yml` 自体は素の宣言(`name`/`type`/`channel`)だけで十分です。
- `mirakurun-data` PVC (`/app-data`) には EPG データベースと収集済みの
  局ロゴが格納されます。
- ビルド元ファイルは `mirakurun/` 以下にあり、サーバー上で直接編集してください。
