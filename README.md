# k3s epg

このディレクトリには EPG スタックの k3s マニフェストとローカルファイルが置かれています。

## クラスタ側の前提条件

このリポジトリには `epg` namespace 内のアプリ本体のマニフェストしか含まれていません。
k3sホストの初期構築やクラスタ共通のアドオン類は別の(プライベートな) bootstrap
リポジトリ側で管理しており、このリポジトリのマニフェストを適用する前に以下が
クラスタ側に用意されている必要があります。

- **StorageClass `local-path-retain`**: `k3s/pvc.yaml` の全PVCが参照。
  `reclaimPolicy: Retain` の local-path プロビジョナー。
- **`auth` namespace とTraefik Middleware**: `k3s/ingress.yaml` が参照する
  `forward-auth`(OIDCによるログイン要求)と `basic-auth` の2つのMiddlewareが
  `auth` namespaceに必要。
- **Traefik のCRD/証明書設定**: `mydnschallenge` certResolver
  (Cloudflare DNS-01でのワイルドカード証明書取得)、および
  `providers.kubernetesCRD.allowCrossNamespace: true`
  (namespaceをまたいだMiddleware参照を許可)が有効になっていること。
- **Sealed Secrets controller**: `kube-system` namespaceの
  `sealed-secrets-controller`。`k3s/sealed-secret.yaml` は対応する秘密鍵を
  持つクラスタでしか復号できないため、新しいクラスタでは
  (バックアップ復元ではなく)ゼロから作る場合、`xool-api-key` /
  `basic-auth-password` を入れ直して作り直す必要がある。
- **ArgoCD**: このリポジトリには `argocd` topicが付与されており、push時に
  ArgoCDへのwebhookが自動登録される運用。ArgoCD Application自体はクラスタの
  state.dbバックアップ/リストアで復元される前提のため、このリポジトリにも
  bootstrap側にもマニフェストとしては存在しない。
- **DNS**: `m.doany.io` / `e.doany.io` がTraefikの外部IPを指すこと。
  `e.home.arpa` はLAN内(`10.10.0.0/16`)専用で、`k3s/tls-secret.yaml` に
  同梱の自己署名証明書で処理される。
- **チューナードライバ**: `k3s/deployment.yaml` の mirakurun は
  `privileged: true` かつ `/dev/bus`・`/dev/dvb` をhostPathでマウントする
  ため、ノード側にPT3/PX4系チューナーのドライバが読み込まれている必要がある。
- **GHCRイメージの公開設定**: `ghcr.io/5ym/mirakurun` /
  `ghcr.io/5ym/epgstation` をpullできること(imagePullSecrets未設定のため
  publicパッケージである前提)。

## チャンネルスキャン

- Mirakurunの Web UI (`http://<host>:40772/`) → 「チャンネル設定」画面右上の
  **Channel Scan** から、`Channel Type`(GR/BS/CS) と `Min/Max Channel` を
  指定してスキャンできます。実機のチューナーで受信状況を見ながら現在使える
  チャンネルを検出する機能です。既存のチャンネル一覧を更新する形にするため
  **Refresh (Update existing channels)** を有効にして実行してください。
- recisdvbはチャンネルの指定形式が異なるため、スキャン画面の
  **Use Channel Name Format** を有効にし、**Channel Name Format** に
  GRなら `T{ch}`、CSなら `CS{ch}` を入力してからスキャンしてください
  (BSは既存のデフォルト `BS{ch00}_{subch}` のままでOK)。
- 目視での転記はミスの元なので、`kubectl cp` でスキャン後のファイルを
  そのまま取り出してリポジトリに上書きするのがおすすめです。

  ```sh
  kubectl -n epg exec "$(kubectl -n epg get pod -l app=mirakurun -o jsonpath='{.items[0].metadata.name}')" -- \
    cat /app-config/channels.yml > ./mirakurun/channels.yml
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
