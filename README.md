# denpa

このディレクトリには EPG スタックの k3s マニフェストとローカルファイルが置かれています。

## 全体構成と移行状況

最終形は **Mirakurun + denpa(自前の録画/エンコード管理) + Jellyfin** です。
現在は移行の途中で、EPGStation と denpa が並走しています。

```text
チューナー ── Mirakurun ─┬─ EPGStation (従来。まだ現役)
                          └─ denpa ── ライブラリ(mkv) ── Jellyfin
```

denpa が実機で録れることを確認するまで EPGStation は残してあります。切り替えは
「denpa 側で予約ルールを作る → 数日並走させて録画が落ちることを確認する →
EPGStation の予約を止める → `k3s/` から epgstation/db の Deployment・Service・
IngressRoute を消す」の順で行ってください。PVC は `Prune=false,Delete=false` が
付いているので、マニフェストから消しても録画データは残ります。

| コンポーネント | 役割 | URL |
| --- | --- | --- |
| Mirakurun | チューナー制御・EPG・TS配信 | `m.doany.io` |
| denpa | 予約・録画・CM検出・エンコード・ライブラリ管理 | `dp.doany.io` |
| Jellyfin | 視聴 | `j.doany.io` |
| EPGStation | 従来の録画基盤(移行完了後に撤去) | `e.doany.io` |

denpa 自体の詳細(状態遷移・環境変数・テスト)は [app/README.md](app/README.md) を参照。

## 実装予定

順番は上から。最後の mirakc 移行は、その前の3つが揃わないと Mirakurun を外せない。

- [ ] **denpa 自前のライブ視聴と追っかけ録画** (下記「ライブ視聴」)
      視聴中は生TSをバッファに書いておき、「ここから録る」で番組の頭から確定する。
      Jellyfin をライブのフロントにする案は撤回済み。
      考えどころは、視聴用の変換済みストリームとは別に Mirakurun へもう1本繋いで生TSを
      書くこと(同じチャンネルなのでチューナーは共有される)、バッファの容量上限、
      番組をまたいで観たときの切り出し、再起動で取り残されたバッファの回収。
- [ ] **チャンネルスキャン**
      いまは Mirakurun の Web UI でスキャンして `mirakurun/channels.yml` を
      `kubectl cp` で吸い出している(下記「チャンネルスキャン」)。これを denpa の画面から
      実行して結果を保存できるようにする。
- [ ] **視聴のついでに局ロゴと番組表を貯める**
      Mirakurun がやっている「ストリームを流している間に EIT と局ロゴを拾う」を denpa 側でも行う。
      局ロゴは Jellyfin のチャンネル画像に使えるほか、CM検出を `join_logo_scp` に
      切り替えるときのロゴデータの元にもなる(下記「CM カット」)。
- [ ] **mirakc に乗り換える**
      上記3つが denpa 側に揃えば、Mirakurun に残る役割はチューナー制御とTS配信だけになる。
      軽量な [mirakc](https://github.com/mirakc/mirakc) は同じAPIを提供するので、
      `MIRAKURUN_URL` の向き先を変えるだけで済むはず。

## EPGStation からの引き継ぎ

EPGStation の MariaDB を読んで、録画ファイルを denpa のライブラリの並びに置き直し、
`.nfo` とサムネイルまで作ります。

**設定画面の「EPGStation からの引き継ぎ」から実行できます。** まず何も選ばずに実行すると
下見(書き込みなし)になり、何が取り込まれるかだけが出ます。中身を確かめてから
「実際に取り込む」を入れて実行してください。数百GBのコピーになるので裏で進み、
進み具合はそのまま画面に出ます。

denpa の Pod に `epgstation-recorded` PVC がマウントされている必要があります
(`k3s/deployment.yaml` に入れてあります)。見えていないときは実行できず、その旨が出ます。

Pod にマウントできない事情があるときは、同じ処理を使い捨てJobでも回せます。

```sh
# まず何が起きるか見る (書き込みはしない)
kubectl -n epg apply -f k3s/migrate-job.yaml
kubectl -n epg logs -f job/denpa-migrate

# 実際に取り込む: migrate-job.yaml の args を ["--apply"] にして applyし直す
```

- **既定はコピー**です。取り込んだ結果を Jellyfin で確かめてから EPGStation 側の
  PVCを消せます。容量が足りないときは `["--apply", "--move"]`
- **何度実行しても同じ結果**になります。取り込み済みは EPGStation 側のIDで判別して飛ばします
- エンコード済みと生TSが両方ある録画は**エンコード済みを取ります**
- 番組表と紐付かない録画(局が消えているなど)も、チャンネル名を残して取り込みます
- Job を使った場合は、終わったら手で消してください (`kubectl -n epg delete job denpa-migrate`)
- 引き継ぎが済んで EPGStation を畳んだら、`k3s/deployment.yaml` の denpa から
  `EPGSTATION_*` と `epgstation-recorded` のマウントを消せます

## 通知

録画の節目を Webhook で外に飛ばせます。設定画面から追加してください
(Discord や Slack の Incoming Webhook の URL をそのまま入れられます)。

- 送れるのは 録画開始 / 録画完了 / 録画失敗 / エンコード完了 / エンコード失敗
- 通知の種類を選ばなければ全部送ります
- **送信は投げっぱなし**です。通知先が遅いせいで録画やエンコードが止まるほうが困るため、
  10秒で打ち切って結果だけ記録します。直近の結果は設定画面に出ます
- 録画の失敗は画面を開くまで気づけないので、**少なくとも失敗だけでも入れておく**のを勧めます

## 開発環境

**ホストに bun は入れません。全部コンテナの中で動かします。**

```sh
docker compose up                          # 開発サーバ(:5173) + 偽Mirakurun(:40772) + Jellyfin(:8096)
docker compose run --rm unit               # 単体テスト
docker compose run --rm e2e                # E2E (Playwright)
docker compose run --rm unit bun run lint  # リント + フォーマット確認
docker compose run --rm unit bun run format # フォーマット適用
```

`node_modules` は名前付きボリュームでイメージの中身を上書きしているので、
**依存を足したあとは `docker compose run --rm unit bun install` を一度回してください**
(イメージを焼き直さなくても反映されます)。

リント/フォーマットは **Biome**(`.ts` / `.js` / `.json` / `.css`)と
**Prettier + prettier-plugin-svelte**(`.svelte`)の2本立てです。Biome だけで
済ませたいところですが、**Biome は Svelte のマークアップを整形できない**
(`<script>` の中しか見ない)ため、テンプレートは Prettier に任せています。
担当範囲は `biome.json` の `files.includes` で `**/*.svelte` を除外して分けてあり、
2つが同じファイルを取り合うことはありません。

なお **CI では Docker を使わず** ランナーに直接 bun を入れて回します
(イメージのビルドに数分かかるうえ、テストは ffmpeg も実チューナーも使わないため)。
bun のバージョンは `app/Dockerfile` の `FROM oven/bun:` から読むので、
どちらか片方だけ上げてもズレません。

- 実チューナーは要りません。`compose.yml` の `mirakurun` サービスが偽Mirakurunで、
  番組表も録画ストリームも返します(1番組60秒)。
- ffmpeg も既定では偽物(`app/tests/fake/ffmpeg.sh`)を使います。本物の ffmpeg は
  ビルドに数十分かかるため、実エンコードを試したいときだけ `app/Dockerfile` の
  `runtime` ステージを使ってください。
- ホストの 5173 が埋まっている場合は `DENPA_PORT=5174 docker compose up`。
- Jellyfin 連携を開発中に試すには、`http://localhost:8096` で初期設定 →
  ライブラリに `/library` を「番組(Shows)」として追加 → APIキーを発行し、
  リポジトリ直下の `.env` に `JELLYFIN_API_KEY=...` を書いて `docker compose up -d app`。

## ライブラリのファイル配置

denpa はエンコード済み mkv とメタデータを次のように置きます。

```text
/library/
└── テストアニメ/
    ├── tvshow.nfo                                     ← シリーズ情報
    └── Season 2026/
        ├── テストアニメ - 2026-08-01 - 2130 決戦.mkv
        ├── テストアニメ - 2026-08-01 - 2130 決戦.nfo       ← 番組名・概要・放送日・放送局
        └── テストアニメ - 2026-08-01 - 2130 決戦-thumb.jpg ← サムネイル
```

日本の番組は話数が無い/リセットされるものが多く SxxExx に落とせないため、Jellyfin が
解釈できる**日付ベースのエピソード**として並べています。

### Jellyfin 側の設定

**denpa の設定画面の「Jellyfin をセットアップ」ボタンで全部やります。**
Jellyfin 側で手作業するのは初回ウィザード(言語と管理ユーザーの作成)だけです。
ボタンが設定するのは以下で、何度押しても重複しません。

1. `/library` を **番組(Shows)** としてライブラリに追加(名前は `JELLYFIN_LIBRARY_NAME`、既定「録画」)
2. **メタデータ保存形式に「Nfo」**、**インターネットのメタデータ取得は無効**。
   日本の放送番組は TheTVDB / TMDB にほぼ載っておらず、有効なままだと denpa が
   書いた `.nfo` が空の検索結果で上書きされます
3. 管理者に **「メディアの削除を許可」**(ライブラリは読み書きでマウントしてあります)。
   全ユーザーに配ると事故るので管理者だけです
4. ライブTVのチューナー(M3U)と番組表(XMLTV)の登録

### 削除の流れ

- 削除は **Jellyfin の UI から**行います。denpa 側には自動削除はありません。
- denpa は `RECONCILE_INTERVAL`(既定5分)ごとにライブラリの実体とDBを突き合わせ、
  消えた録画を「削除済み」に倒して一覧から外し、残った `.nfo` / サムネイルと
  空フォルダも片付けます。ライブラリ画面の「ライブラリを照合」で即座に走らせることも
  できます。
- denpa 側のライブラリ画面からも削除できます(生TSが残っていればそれも消します)。

## ライブ視聴

**Jellyfin では行いません。denpa 側に自前で実装する方針です(未実装)。**

Jellyfin をライブTVのフロントにする案は一度組んで動くところまで確認しましたが、
撤回しました。denpa をチューナーとして登録すれば MPEG-2 の実時間トランスコードは
避けられるものの、その先で Jellyfin の作りに縛られる点が多すぎたためです。

- ライブTVと録画ライブラリが**必ず別のタイルに分かれる**。統合も、ライブTV内の
  「録画」タブを隠すこともできない
- 録画ボタンで作られるタイマーを知らせる仕組みが無いので、**denpa が定期的に
  見に行くしかない**。押してから反映まで待ちがある
- Jellyfin の DVR を有効にすると denpa と録画先を取り合う。無効にすると
  「録画」タブが永久に空のまま残る
- 画質・遅延・字幕の扱いを決めるのは結局 denpa 側なのに、**操作は Jellyfin 側**という
  ねじれが残る

自前でやるなら、視聴・追っかけ録画・チューナーの取り合いを1箇所で決められます。

### 実装予定の形

```text
denpa でチャンネルを選ぶ
  ├→ 視聴用: H.264 に変換して配る (ブラウザで再生)
  └→ 同時に生TSをバッファに書く
       └→ 「ここから録る」を押したら、バッファごと番組の頭から確定して
          番組終了まで録り続ける
       └→ 押されずに視聴をやめたらバッファは捨てる
```

- 視聴中は**常に生TSをバッファに書く**ので、途中から「やっぱり録る」と決めても
  番組の頭から残せます。上限を決めて古い側から捨てます(生TSは約6.6GB/時)
- 同じチャンネルなので Mirakurun 側でチューナーは共有され、増えるのは
  ディスク書き込みだけです
- 番組の頭までの余分はエンコード時に `-ss` で落とします

Jellyfin は**録画済みを観るためだけ**に使い、ライブTVのチューナーは登録しません。

## 録画のエンコード

既定は AV1 (10bit) + Opus + dvdsub の Matroska です。同じ画質でファイルは小さくなりますが
エンコードに時間がかかるため、**非力なマシン向けに H.264 (8bit) も選べます**。
音声・字幕・コンテナは変わりません。

- 既定値は `ENCODE_CODEC`(`av1` / `h264`)
- ルールごとに「映像コーデック」で個別指定できます
- H.264 の品質は `ENCODE_H264_PRESET`(既定 `medium`)と `ENCODE_H264_CRF`(既定 22)
- 検出は既定で「無音 + CMは15秒の倍数」のヒューリスティック(`CM_DETECTOR=silence`)。
  追加のツールもロゴデータも要りません。
- より高精度にしたい場合は `CM_DETECTOR=jls` で **join_logo_scp**
  (Amatsukaze と同じ検出核) に任せられます。ただし Amatsukaze 本体は Windows +
  AviSynth+ 前提で Linux の Pod には載らないため、使うのは Linux 移植版の
  `chapter_exe` / `logoframe` / `join_logo_scp` と、**局ごとのロゴデータ(.lgd)** です。
  これらは現在のイメージには入っておらず、自分で焼き込む必要があります。
  denpa 側は生成された avs の `Trim()` を読むだけなので、エンコード自体は
  AviSynth を経由しません。ロゴ未整備などで検出できなかったときは無音検出に落ちます。

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
- **DNS**: `m.doany.io` / `e.doany.io` / `dp.doany.io` / `j.doany.io` がTraefikの
  外部IPを指すこと。`e.home.arpa` はLAN内(`10.10.0.0/16`)専用で、
  `k3s/tls-secret.yaml` に同梱の自己署名証明書で処理される。
  なお `j.doany.io` (Jellyfin) だけは forward-auth を通していない。TV・スマホの
  Jellyfinアプリが OIDC のリダイレクトを扱えないため、Jellyfin自身のログインに任せている。
- **チューナードライバ**: `k3s/deployment.yaml` の mirakurun は
  `privileged: true` かつ `/dev/bus`・`/dev/dvb` をhostPathでマウントする
  ため、ノード側にPT3/PX4系チューナーのドライバが読み込まれている必要がある。
- **GHCRイメージの公開設定**: `ghcr.io/danything/mirakurun` /
  `ghcr.io/danything/epgstation` / `ghcr.io/danything/denpa` をpullできること
  (imagePullSecrets未設定のため publicパッケージである前提)。
- **Jellyfin APIキー**: Jellyfin 連携の要。**denpa の設定画面から発行できる**ので
  事前に用意する必要はない(APIキーは Jellyfin のセットアップを終えてからでないと
  作れないため、そもそも事前に用意できない)。管理者のID/パスワードを一度入力すると
  denpa がキーを発行してDBに保存し、パスワードは保存しない。
  env や SealedSecret (`denpa-secrets` の `jellyfin-api-key`) で渡すこともでき、
  その場合は設定画面の値が優先される。未設定でも Pod は起動し**録画とエンコードは動く**が、
  以下が全部止まる:
  - Jellyfin の録画ボタンで作られたタイマーの取り込み
  - 「JellyfinにライブTVを登録」ボタン
  - 新しい録画を置いたときの再スキャン要求(Jellyfin 自身の定期スキャン待ちになる)
- **同一ノード配置**: `denpa-library` PVC は ReadWriteOnce のため、denpa と
  Jellyfin は同じノードに載る必要がある。local-path の PV はノードアフィニティを
  持つので、単一ノード構成なら特に指定は要らない。

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
  kubectl -n epg exec deploy/mirakurun -- cat /app-config/channels.yml > ./mirakurun/channels.yml
  ```

  `git diff` で意図しない変更が無いか確認してからcommit・pushしてください。
  `build-and-deploy.yml` が `mirakurun/*.yml` の変更を検知してイメージを
  再ビルド・再デプロイします。

