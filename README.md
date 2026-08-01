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

- [ ] **Jellyfin で視聴を始めたら追っかけ録画する**
      いま入れてあるのは「Jellyfinの録画ボタン → タイマーをdenpaが回収」まで(下記
      「Jellyfin の録画ボタン」)。押した時点からしか録れないので、視聴を始めた時点で
      生TSをバッファに録っておき、押されたら番組の頭から残す・押されなければ捨てる、に広げる。
      denpa 自身がストリーム元なので視聴の開始/終了は既に把握できており、Webhookは不要。
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

1. `/library` を **番組(Shows)** としてライブラリに追加
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

視聴は Jellyfin で行いますが、**Mirakurun ではなく denpa をチューナーとして登録**します。
denpa が MPEG-2 を変換してから渡すので、Jellyfin 側はリマックスするだけで済み、
コーデック・プリセット・字幕の扱いをこちらで決められます。

```text
Mirakurun ──(MPEG-2)── denpa /api/live/{id}/{profile} ──(H.264 or AV1)── Jellyfin ── クライアント
```

Mirakurun の `/api/iptv/*` を直接 Jellyfin に渡すこともできますが、それだと
Jellyfin が MPEG-2 を実時間トランスコードすることになり、その中身を指定できません。

### 設定

**Jellyfin の初回セットアップウィザードにはライブTVの項目がありません。**
セットアップを終えたあと、denpa のダッシュボードの
**「JellyfinにライブTVを登録」**を押すと、以下2つが Jellyfin に登録されます
(何度押しても重複しません)。API キー(`JELLYFIN_API_KEY`)が必要です。

| 登録先 | URL | 役割 |
| --- | --- | --- |
| チューナーデバイス (M3U Tuner) | `/api/iptv/playlist.m3u?profile=h264` | **チャンネル一覧とストリームURL**。無いとチャンネルが1つも出ない |
| ガイドデータプロバイダー (XMLTV) | `/api/iptv/xmltv.xml` | **番組表**。無いとチャンネルは映るが番組名が空欄になり、予約もできない |

両者は M3U の `tvg-id` と XMLTV の `<channel id>` の一致で結び付きます
(どちらも Mirakurun のサービスID)。手で入れる場合もこの2つを別々に登録してください。

Jellyfin から見た denpa のURLは `IPTV_ORIGIN` で指定します(k3s では
`http://denpa:3000`)。未設定ならリクエストのオリジンから決めます。

チャンネル一覧も番組表も denpa のDBから作られるので、denpa の番組表と食い違いません。
配信中の中継は denpa のダッシュボードに出ます(チューナーを掴んだままになっていないか
確認でき、そこから切断もできます)。

### プロファイル

`?profile=` で切り替えられます。既定は `LIVE_PROFILE`(既定 `h264`)。

| | 映像 | 音声 | 字幕 | コンテナ |
| --- | --- | --- | --- | --- |
| `h264` | H.264 8bit | AAC | **DVB字幕** | MPEG-TS |
| `av1` | AV1 10bit | Opus | **dvdsub** | Matroska |

ARIB字幕は libaribcaption でビットマップとして取り出し、それぞれのコンテナで
扱える字幕形式に載せ替えています(焼き込みではないので表示のオン/オフができます)。
dvdsub は MPEG-TS に入れられないため、AV1 側は録画済みファイルと同じ Matroska です。

### Jellyfin の録画ボタン

Jellyfin のライブTV画面で録画ボタンを押すと Jellyfin にタイマーが作られます。denpa は
`JELLYFIN_TIMER_INTERVAL`(既定30秒)ごとにそれを拾い、**denpa の予約に変換して
Jellyfin 側のタイマーを消します**。予約一覧の「Jellyfinの録画予約を取り込む」で
すぐ走らせることもできます。

こうしているのは、Jellyfin に録画させると**変換済みのH.264を録ることになり**、
生TS + AV1 + CM検出 + ライブラリ命名という denpa の経路を通らないためです。
**Jellyfin 側には録画フォルダを設定しないでください。**設定しなければ Jellyfin は
実際には録画できず、タイマーだけが残るので安全に横取りできます。

- タイマー作成を知らせる Webhook は Jellyfin に無いため、定期的に見に行く方式です
  (押してから予約に反映されるまで最大30秒)。
- **シリーズ録画は取り込みません。**Jellyfin が番組表更新のたびにタイマーを作り直すので
  消しても復活し、取り合いになります。繰り返し録画は denpa のルールを使ってください。
- 番組を特定できなかったタイマーは Jellyfin 側に残し、予約一覧に理由を出します
  (消してしまうと録り逃すため)。

### 仕様上の制約

- **AV1 プロファイルはソフトウェアエンコードでは実時間に間に合いません。**
  録画側の AV1 は実時間より遅いバッチ処理です。ライブ用に `LIVE_AV1_PRESET`
  (既定10、大きいほど速い)をかなり速い側へ振ってありますが、HDを CPU だけで
  実時間エンコードするのは厳しく、実用するにはハードウェアAV1エンコーダ
  (Intel Arc / 最近のiGPU / RX7000系)が要ります。既定が `h264` なのはそのため。
- **同時配信数はCPU次第。** 1本ごとに ffmpeg が1つ立ちます。同じチャンネルなら
  Mirakurun 側でチューナーは共有されますが、エンコードは視聴者ぶん走ります。
- **Jellyfin の DVR(録画)機能は使わない**。予約管理は denpa に一本化する。
  両方が予約を持つとチューナーの取り合いになり、同じライブラリに二重に書き込む。
- **チューナーは録画と共有**(GR 2本 / BS・CS 2本)。denpa は録画時に
  `X-Mirakurun-Priority: 2`、ライブ配信は 0 を使っているので
  ([mirakurun.ts](app/src/lib/server/mirakurun.ts))、**録画開始時には配信側が切られます**。
  逆に denpa の競合判定は配信を数に入れていないため、予約一覧には競合として出ません。
- 相手が切ったことが伝わらなかった場合に備え、読まれなくなった中継は
  `LIVE_IDLE_TIMEOUT`(既定30秒)で自動的に止めてチューナーを解放します。

> 登録とチャンネル・番組表の取り込みは実 Jellyfin 10.11.7 で確認済みです
> (偽Mirakurunの番組表360件が Jellyfin のガイドに入るところまで)。
> ただし**実チューナーでの映像の再生は未確認**で、特に
> **Jellyfin の M3U Tuner が Matroska のライブストリーム(AV1側)を受けられるか**は
> 分かっていません。ダメだった場合は AV1 側も dvbsub + MPEG-TS に変える必要があります。

## CM カット

- 既定は**チャプター付与のみ**(`CM_CUT_DEFAULT=chapter`)です。CM区間を mkv の
  チャプターとして書き込むだけなので、検出を誤っても本編は失われません。
  Jellyfin のチャプター送りで飛ばせます。
- 実際に切りたい場合はルール単位で「実際に切る」を選びます。切った後の時刻に
  追従できないため、**実カットでは字幕ストリームが落ちます**。

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
