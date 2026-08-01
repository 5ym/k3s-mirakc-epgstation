# denpa

このディレクトリには EPG スタックの k3s マニフェストとローカルファイルが置かれています。

## 全体構成と移行状況

**Mirakurun + denpa(自前の録画/エンコード管理)** です。
視聴用のメディアサーバは置きません。denpa がファイルをそのまま配り、
再生は端末のプレイヤー(mpv / VLC / Kodi / Infuse)に任せます。

```text
チューナー ── Mirakurun ── denpa ── 録画(mkv) ─┬─→ mpv / VLC / Infuse (URLスキーム)
                                               └─→ Kodi (WebDAV)
```

EPGStation は**停止済み**です。MariaDB だけは引き継ぎ(ルール・予約・録画)が
済むまで残してあります。

引き継ぎが済んだら、`k3s/deployment.yaml` の `db` と `k3s/service.yaml` の `db`、
`epg-db` / `epgstation-*` の PVC、`k3s/sealed-secret.yaml`、`k3s/tls-secret.yaml` を
消せます。PVC には `Prune=false,Delete=false` が付いているので、マニフェストから
消しても録画データは残ります(消すのは手作業)。

| コンポーネント | 役割 | URL |
| --- | --- | --- |
| Mirakurun | チューナー制御・EPG・TS配信 | `m.doany.io` |
| denpa | 予約・録画・CM検出・エンコード・ライブラリ管理 | `dp.doany.io` |

denpa 自体の詳細(状態遷移・環境変数・テスト)は [app/README.md](app/README.md) を参照。

## 実装予定

順番は上から。最後の mirakc 移行は、その前の3つが揃わないと Mirakurun を外せない。

- [ ] **denpa 自前のライブ視聴と追っかけ録画** (下記「ライブ視聴」)
      視聴中は生TSをバッファに書いておき、「ここから録る」で番組の頭から確定する。
      考えどころは、視聴用の変換済みストリームとは別に Mirakurun へもう1本繋いで生TSを
      書くこと(同じチャンネルなのでチューナーは共有される)、バッファの容量上限、
      番組をまたいで観たときの切り出し、再起動で取り残されたバッファの回収。
- [ ] **チャンネルスキャン**
      いまは Mirakurun の Web UI でスキャンして `mirakurun/channels.yml` を
      `kubectl cp` で吸い出している(下記「チャンネルスキャン」)。これを denpa の画面から
      実行して結果を保存できるようにする。
- [ ] **視聴のついでに局ロゴと番組表を貯める**
      Mirakurun がやっている「ストリームを流している間に EIT と局ロゴを拾う」を denpa 側でも行う。
      局ロゴは番組表に出すほか、CM検出を `join_logo_scp` に
      切り替えるときのロゴデータの元にもなる(下記「CM カット」)。
- [ ] **mirakc に乗り換える**
      上記3つが denpa 側に揃えば、Mirakurun に残る役割はチューナー制御とTS配信だけになる。
      軽量な [mirakc](https://github.com/mirakc/mirakc) は同じAPIを提供するので、
      `MIRAKURUN_URL` の向き先を変えるだけで済むはず。

## EPGStation からの引き継ぎ

EPGStation の MariaDB を読んで、**自動予約ルール・手で入れた予約・録画**を取り込みます。
録画ファイルは denpa のライブラリの並びに置き直し、`.nfo` とサムネイルまで作ります。

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

- **既定はコピー**です。取り込んだ結果を確かめてから EPGStation 側の
  PVCを消せます。容量が足りないときは `["--apply", "--move"]`
- **何度実行しても同じ結果**になります。取り込み済みは EPGStation 側のIDで判別して飛ばします
- エンコード済みと生TSが両方ある録画は**エンコード済みを取ります**
- 番組表と紐付かない録画(局が消えているなど)も、チャンネル名を残して取り込みます
- **ルール由来の予約は取り込みません**。ルールを入れたあと denpa が自分で立て直すためです。
  取り込むのは手で入れた予約だけです
- EPGStation のルールには denpa に無い項目(正規表現・時刻指定・録画先の指定・重複回避)が
  あります。**時刻指定のルールと、条件が空になるものは取り込めません**。何が落ちたかは
  実行結果の記録に出ます
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
docker compose up                          # 開発サーバ(:5173) + 偽Mirakurun(:40772)
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

日本の番組は話数が無い/リセットされるものが多く SxxExx に落とせないため、
**日付ベースのエピソード**として並べています。

### 視聴

**メディアサーバは置きません。** denpa が録画ファイルをそのまま配り、
再生は端末に入っているプレイヤーに任せます。ブラウザは MPEG-2 も AV1+Opus の mkv も
素直には再生できないので、ライブラリ画面のボタンから外部プレイヤーを起動します。

| 端末 | 渡し方 | 必要なもの |
| --- | --- | --- |
| Windows | `mpv://play/<base64url>/` | [mpv-handler](https://github.com/akiirui/mpv-handler) |
| Android | `intent://...action=VIEW;type=video/*` | 動画が再生できるアプリ(端末が選択画面を出す) |
| iOS | `vlc-x-callback://` / `infuse://` | VLC または Infuse |
| その他 | 素のURL | 好きなプレイヤーに貼る |

Android はアプリを名指ししません。入っていないときに何も起きないうえ、
好みも人それぞれなので、どのアプリで開くかは端末に選ばせます。
番組名を渡せるもの(Android の `S.title`、Infuse の `name`)には渡しています。

配信は `/api/recordings/<id>/file` です。Range に対応しているので、
プレイヤー側から早送りできます。エンコード済みがあればそれを、無ければ生TSを返します。

### Kodi (WebDAV)

Kodi からは `/dav` を **WebDAV サーバー**として追加すると、フォルダ構成そのままで開けます。
`.nfo` とサムネイルも動画の隣に置いてあるので、番組名・概要・放送局・サムネイルが出ます。
書き込み系(PUT / DELETE / MKCOL)は受けません。消すのは denpa の画面からです。

### ベーシック認証

mpv も Kodi も、画面の前段に置く forward-auth のようなリダイレクト型の認証を扱えません。
そこで**ファイルを取りに来る口だけ**にベーシック認証をかけられるようにしてあります。

- `BASIC_AUTH_USER` と `BASIC_AUTH_PASSWORD` の**両方**が入っているときだけ有効
- `BASIC_AUTH_SCOPE=files`(既定)… `/api/recordings/<id>/file` と `/dav` だけ。画面は素通し
- `BASIC_AUTH_SCOPE=all` … 画面も含めて全部

再生リンクの URL には資格情報を埋め込みます(`http://user:pass@.../file`)。
mpv も Infuse も認証ダイアログを出さないためです。

> **注意**: `files` のときは録画一覧の画面自体に認証がかかりません。
> 画面を開ければ再生リンクの中のパスワードも見えるので、
> **画面の前段に別の認証を置いている前提**の設定です。

### 削除の流れ

- 削除は **denpa のライブラリ画面から**行います。自動削除はありません。
- ファイルマネージャなど外から消された場合も、`RECONCILE_INTERVAL`(既定5分)ごとに
  ライブラリの実体とDBを突き合わせ、消えた録画を「削除済み」に倒して一覧から外します。
  残った `.nfo` / サムネイルと空フォルダも片付けます。ライブラリ画面の
  「ライブラリを照合」で即座に走らせることもできます。

## ライブ視聴

**未実装です。denpa 側に自前で実装します。**

視聴・追っかけ録画・チューナーの取り合いを1箇所で決めたいので、外のメディアサーバには
任せません。

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

## CM の扱い

既定は**チャプターを打つだけ**です。実カットは誤検出すると本編が消えるので、
番組ごと・ルールごとに選びます。

実際に切るときは、**エンコードの前にTSの段階で切ります**。残す区間を `-c copy` で
切り出して concat デマクサで繋ぎ、そのTSを普通にエンコードします。

エンコードのフィルタ (`select`) で切っていた頃は、ARIB字幕のタイミングを
追従させられず `-sn` で落とすしかありませんでした。先にTSを切ってしまえば、
あとは通常どおりエンコードするだけで**字幕もそのまま残ります**(焼き込みではないので
再生中に消せます)。再エンコードを挟まないぶん速くもなります。

`-c copy` はキーフレーム単位の切り出しになりますが、日本の地上波の MPEG-2 は
GOP が 0.5 秒程度なので、CM検出の許容誤差 (`CM_TOLERANCE`) に収まります。
元のTSは残したままなので、切り方を間違えても録画は失われません。

### 検出方法は2つ (`CM_DETECTOR`)

**`silence`(既定)** — 無音とシーンの尺だけで判断します。追加の依存が無く、
どのチャンネルでもそのまま動きます。CM が15秒の倍数で並ぶ性質を使って絞り込みますが、
本編中の「間(ま)」を拾うことがあり、Amatsukaze ほどの精度は出ません。

**`jls`** — Amatsukaze と同じ考え方です。無音・シーンチェンジ (`chapter_exe`) に加えて
**局ロゴが出ているか** (`logoframe`) を見て、`join_logo_scp` が突き合わせて本編/CMを
判定します。CM 中はロゴが消えるので、無音だけより格段に確かです。

Amatsukaze 本体は Windows + AviSynth+ 前提で Pod には載りませんが、**検出核には
Linux 移植があります** ([tobitti0/JoinLogoScpTrialSetLinux](https://github.com/tobitti0/JoinLogoScpTrialSetLinux))。
denpa はその成果物である `Trim(開始,終了)` の並んだ avs を読むだけなので、
エンコード自体は AviSynth を通さず ffmpeg のままです (`src/lib/server/cm-jls.ts`)。

使うには以下が要ります。

- イメージに `chapter_exe` / `logoframe` / `join_logo_scp` と **AviSynth+ 3.5.x**
- **局ごとのロゴデータ (`.lgd`)**。自分の録画から作る必要があり、局が増えるたびに追加する
- `CM_DETECTOR=jls` と、起動コマンド `CM_JLS_COMMAND`

移植は 2020 年で更新が止まっているので、AviSynth+ のバージョンを固定する必要があります。
ロゴデータの用意が手間なので、既定は `silence` のままにしてあります。

## 録画のエンコード

既定は AV1 (10bit) + Opus + dvbsub の Matroska です。同じ画質でファイルは小さくなりますが
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
- **DNS**: `m.doany.io` / `dp.doany.io` がTraefikの外部IPを指すこと。
  (`e.doany.io` と `e.home.arpa` は EPGStation 用だったので不要になった)
- **チューナードライバ**: `k3s/deployment.yaml` の mirakurun は
  `privileged: true` かつ `/dev/bus`・`/dev/dvb` をhostPathでマウントする
  ため、ノード側にPT3/PX4系チューナーのドライバが読み込まれている必要がある。
- **GHCRイメージの公開設定**: `ghcr.io/danything/mirakurun` と
  `ghcr.io/danything/denpa` をpullできること
  (imagePullSecrets未設定のため publicパッケージである前提)。

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
