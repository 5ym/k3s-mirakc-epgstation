# denpa

EPG スタックの k3s マニフェストと設定ファイル。

**Mirakurun + denpa(自前の録画/エンコード管理)** の2つだけです。メディアサーバは
置きません。denpa がファイルをそのまま配り、再生は端末のプレイヤーに任せます。

```text
チューナー ── Mirakurun ── denpa ── 録画(mkv) ─┬─→ mpv / VLC / Infuse (URLスキーム)
                                               └─→ Kodi (WebDAV)
```

| コンポーネント | 役割 | URL |
| --- | --- | --- |
| Mirakurun | チューナー制御・EPG・TS配信 | `m.doany.io` |
| denpa | 予約・録画・CM検出・エンコード・録画の配信 | `dp.doany.io` / `dp.home.arpa` |

`dp.doany.io` は forward-auth を通します。`dp.home.arpa` は LAN 内(`10.10.0.0/16`)
専用で、forward-auth を通さず denpa 自身のベーシック認証に任せます。mpv も Kodi も
OIDC のリダイレクトを扱えないためです。**平文の http で出しています**
(`.arpa` は ACME で証明書を取れず、自己署名だとプレイヤーが弾くことがある)。
http→https のリダイレクトは Traefik 側で `doany.io` 系だけにかけてあります。

denpa 自体の詳細(状態遷移・環境変数・テスト)は [app/README.md](app/README.md)。

EPGStation は停止済みです。MariaDB だけは引き継ぎが済むまで残してあります。済んだら
`k3s/deployment.yaml` と `k3s/service.yaml` の `db`、`epg-db` / `epgstation-*` の PVC、
`k3s/sealed-secret.yaml` を消せます。PVC には `Prune=false,Delete=false` が付いているので、
マニフェストから消しても録画データは残ります。

## 実装予定

上から順に。最後の mirakc 移行は、その前の3つが揃わないと Mirakurun を外せません。

- **ライブ視聴と追っかけ録画**(下記)
- **チャンネルスキャン** — いまは Mirakurun の Web UI でスキャンして
  `mirakurun/channels.yml` を `kubectl cp` で吸い出している(下記)。これを denpa の
  画面からやれるようにする
- **視聴のついでに局ロゴと番組表を貯める** — Mirakurun がやっている「ストリームを
  流している間に EIT と局ロゴを拾う」を denpa 側でも行う。ロゴは番組表に出すほか、
  CM検出を `join_logo_scp` に切り替えるときの元にもなる
- **[mirakc](https://github.com/mirakc/mirakc) に乗り換える** — 上の3つが揃えば
  Mirakurun に残る役割はチューナー制御とTS配信だけになる。同じAPIなので
  `MIRAKURUN_URL` の向き先を変えるだけで済むはず

## 開発環境

**ホストに bun は入れません。全部コンテナの中で動かします。**

```sh
docker compose up                           # 開発サーバ(:5173) + 偽Mirakurun(:40772)
docker compose run --rm unit                # 単体テスト
docker compose run --rm e2e                 # E2E (Playwright)
docker compose run --rm unit bun run lint   # リント + フォーマット確認
docker compose run --rm unit bun run format # フォーマット適用
```

実チューナーも ffmpeg も要りません。偽Mirakurun が番組表も録画ストリームも返し
(1番組60秒)、ffmpeg も既定では偽物(`app/tests/fake/ffmpeg.sh`)を使います。
本物の ffmpeg はビルドに数十分かかるので、実エンコードを試したいときだけ
`app/Dockerfile` の `runtime` ステージを使ってください。

- `node_modules` は名前付きボリュームなので、**依存を足したら
  `docker compose run --rm unit bun install` を一度**回す(イメージの焼き直しは不要)
- ホストの 5173 が埋まっていれば `DENPA_PORT=5174 docker compose up`
- リント/フォーマットは **Biome**(`.ts`/`.js`/`.json`/`.css`)と
  **Prettier + prettier-plugin-svelte**(`.svelte`)の2本立て。Biome は Svelte の
  マークアップを整形できない(`<script>` の中しか見ない)ため。担当範囲は
  `biome.json` の `files.includes` で分けてあり、取り合いません
- **CI では Docker を使わず**ランナーに直接 bun を入れます(イメージのビルドが遅く、
  テストは ffmpeg も実チューナーも使わないため)。bun のバージョンは
  `app/Dockerfile` の `FROM oven/bun:` から読むのでズレません

## ライブラリと視聴

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

ブラウザは MPEG-2 も AV1+Opus の mkv も素直には再生できないので、録画一覧のボタンから
端末のプレイヤーを起動します。

| 端末 | 渡し方 | 必要なもの |
| --- | --- | --- |
| Windows | `mpv://play/<base64url>/` | [mpv-handler](https://github.com/akiirui/mpv-handler) — 登録は [windows/mpv-handler.ps1](windows/mpv-handler.ps1) |
| Android | `intent://...action=VIEW;type=video/*` | 動画が再生できるアプリ(端末が選択画面を出す) |
| iOS | `vlc-x-callback://` / `infuse://` | VLC または Infuse |
| その他 | 素のURL | 好きなプレイヤーに貼る |

Android はアプリを名指ししません。入っていないときに何も起きないうえ好みも人それぞれ
なので、端末に選ばせます。番組名を渡せるもの(Android の `S.title`、Infuse の `name`)
には渡しています。

配信は `/api/recordings/<id>/file`。Range に対応しているのでプレイヤー側から早送り
できます。エンコード済みがあればそれを、無ければ生TSを返します。

Kodi からは `/dav` を **WebDAV サーバー**として追加するとフォルダ構成そのままで開けます。
`.nfo` とサムネイルが動画の隣にあるので番組名・概要・放送局・サムネイルも出ます。
書き込み系(PUT / DELETE / MKCOL)は受けません。

### ベーシック認証

mpv も Kodi もリダイレクト型の認証を扱えないので、**ファイルを取りに来る口だけ**に
かけられるようにしてあります。**設定画面から入れます**(環境変数
`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` / `BASIC_AUTH_SCOPE` は初期値としても
使えますが、画面の値が勝ちます)。

- ユーザー名とパスワードの**両方**が入っているときだけ有効
- 「配信と WebDAV だけ」(既定)… `/api/recordings/<id>/file` と `/dav`。画面は素通し
- 「画面も含めて全部」… すべてのパス

再生リンクの URL には資格情報を埋め込みます(`http://user:pass@.../file`)。mpv も
Infuse も認証ダイアログを出さないためです。

> **注意**: 既定では録画一覧の画面自体に認証がかかりません。画面を開けば再生リンクの
> 中のパスワードも見えるので、**画面の前段に別の認証を置いている前提**の設定です。

### 削除

**denpa の画面から**行います。自動削除はありません。外から消された場合も
`RECONCILE_INTERVAL`(既定5分)ごとに実体とDBを突き合わせ、消えた録画を「削除済み」に
倒して一覧から外します。残った `.nfo` / サムネイルと空フォルダも片付けます。
「実体と照合」ボタンで即座に走らせられます。

## CM とエンコード

既定は AV1 (10bit) + Opus + dvbsub の Matroska。同じ画質でファイルは小さくなりますが
時間がかかるので、**非力なマシン向けに H.264 (8bit) も選べます**(`ENCODE_CODEC`、
`ENCODE_H264_PRESET`、`ENCODE_H264_CRF`)。音声・字幕・コンテナは変わりません。

CM は既定で**チャプターを打つだけ**です。実カットは誤検出すると本編が消えるので明示的に
選びます。切るときは**エンコードの前にTSの段階で切ります**。残す区間を `-c copy` で
切り出して concat デマクサで繋ぎ、そのTSを普通にエンコードします。

エンコードのフィルタ (`select`) で切っていた頃は ARIB字幕のタイミングを追従させられず
`-sn` で落とすしかありませんでした。先にTSを切ってしまえば**字幕もそのまま残ります**
(焼き込みではないので再生中に消せます)。再エンコードを挟まないぶん速くもなります。
`-c copy` はキーフレーム単位ですが、地上波の MPEG-2 は GOP が 0.5 秒程度なので
CM検出の許容誤差 (`CM_TOLERANCE`) に収まります。元のTSは残るので失敗しても戻せます。

### 検出方法は2つ (`CM_DETECTOR`)

**`silence`(既定)** — 無音とシーンの尺だけで判断。追加の依存が無くどこでも動きます。
CM が15秒の倍数で並ぶ性質で絞り込みますが、本編中の「間(ま)」を拾うことがあり、
Amatsukaze ほどの精度は出ません。

**`jls`** — Amatsukaze と同じ考え方。無音・シーンチェンジ (`chapter_exe`) に加えて
**局ロゴが出ているか** (`logoframe`) を見て `join_logo_scp` が判定します。CM 中はロゴが
消えるので無音だけより格段に確かです。

Amatsukaze 本体は Windows + AviSynth+ 前提で Pod には載りませんが、検出核には
Linux 移植があります ([tobitti0/JoinLogoScpTrialSetLinux](https://github.com/tobitti0/JoinLogoScpTrialSetLinux))。
denpa はその成果物である `Trim(開始,終了)` の並んだ avs を読むだけなので、エンコード自体は
AviSynth を通さず ffmpeg のままです (`app/src/lib/server/cm-jls.ts`)。使うには
イメージに `chapter_exe` / `logoframe` / `join_logo_scp` と **AviSynth+ 3.5.x**、
**局ごとのロゴデータ (`.lgd`)**、`CM_DETECTOR=jls` と `CM_JLS_COMMAND` が要ります。
移植は 2020 年で更新が止まっているのでバージョン固定が必要で、ロゴの用意も手間なため
既定は `silence` のままです。検出できなければ無音検出に落ちます。

## ライブ視聴(未実装)

視聴・追っかけ録画・チューナーの取り合いを1箇所で決めたいので、外のメディアサーバには
任せず denpa 側に実装します。

```text
denpa でチャンネルを選ぶ
  ├→ 視聴用: H.264 に変換して配る (ブラウザで再生)
  └→ 同時に生TSをバッファに書く
       └→ 「ここから録る」で番組の頭から確定し、終了まで録り続ける
       └→ 押されずにやめたらバッファは捨てる
```

視聴中は常に生TSを書くので、途中から「やっぱり録る」と決めても頭から残せます。上限を
決めて古い側から捨てます(生TSは約6.6GB/時)。同じチャンネルなので Mirakurun 側で
チューナーは共有され、増えるのはディスク書き込みだけです。番組の頭までの余分は
エンコード時に `-ss` で落とします。

## 通知

録画の節目を Webhook で外に飛ばせます。設定画面から追加してください(Discord や Slack の
Incoming Webhook の URL をそのまま入れられます)。

- 録画開始 / 録画完了 / 録画失敗 / エンコード完了 / エンコード失敗。選ばなければ全部
- **送信は投げっぱなし**です。通知先が遅いせいで録画が止まるほうが困るので、10秒で
  打ち切って結果だけ記録します。直近の結果は設定画面に出ます
- 録画の失敗は画面を開くまで気づけないので、**少なくとも失敗だけでも**入れておくのを勧めます

## EPGStation からの引き継ぎ

EPGStation の MariaDB を読んで、**自動予約ルール・手で入れた予約・録画**を取り込みます。
録画ファイルは denpa のライブラリの並びに置き直し、`.nfo` とサムネイルまで作ります。

**設定画面から実行できます。** まず何も選ばずに実行すると下見(書き込みなし)になり、
何が取り込まれるかだけが出ます。確かめてから「実際に取り込む」を入れて実行してください。
数百GBのコピーになるので裏で進み、進み具合はそのまま画面に出ます。

denpa の Pod に `epgstation-recorded` PVC がマウントされている必要があります
(`k3s/deployment.yaml` に入れてあります)。マウントできない事情があるときは、同じ処理を
使い捨てJobでも回せます(`k3s/migrate-job.yaml` を apply。`args` を `["--apply"]` に
すると実際に取り込む)。

- **既定はコピー**。結果を確かめてから EPGStation 側の PVC を消せます。容量が足りない
  ときは `["--apply", "--move"]`
- **何度実行しても同じ結果**になります(取り込み済みは EPGStation 側のIDで判別)
- エンコード済みと生TSが両方ある録画は**エンコード済みを取ります**
- 番組表と紐付かない録画も、チャンネル名を残して取り込みます
- **ルール由来の予約は取り込みません**。ルールを入れたあと denpa が自分で立て直すため
- EPGStation のルールには denpa に無い項目(正規表現・時刻指定・録画先の指定・重複回避)が
  あります。**時刻指定のルールと、条件が空になるものは取り込めません**。何が落ちたかは
  実行結果に出ます
- 済んだら `k3s/deployment.yaml` の denpa から `EPGSTATION_*` と
  `epgstation-recorded` のマウントを消せます

## クラスタ側の前提条件

このリポジトリには `epg` namespace のアプリ本体しか入っていません。k3sホストの初期構築や
共通アドオンは別の(プライベートな) bootstrap リポジトリ側です。適用前に以下が要ります。

- **StorageClass `local-path-retain`** — `reclaimPolicy: Retain` の local-path
- **`auth` namespace の Traefik Middleware** — `forward-auth`
- **Traefik** — `mydnschallenge` certResolver (Cloudflare DNS-01)、
  `providers.kubernetesCRD.allowCrossNamespace: true`、および
  http→https リダイレクトが `doany.io` 系だけに限定されていること
  (bootstrap の `traefik/redirect-https.yaml`)。`web` エントリポイント全体に
  かけると `dp.home.arpa` も飛ばされます
- **Sealed Secrets controller** — `kube-system`。`k3s/sealed-secret.yaml` は対応する
  秘密鍵を持つクラスタでしか復号できないので、ゼロから作る場合は入れ直しが必要
- **ArgoCD** — push時に webhook が自動登録される運用。Application 自体はクラスタの
  state.db バックアップから復元される前提でマニフェストとしては存在しません
- **DNS** — `m.doany.io` / `dp.doany.io` が Traefik の外部IPを指すこと。LAN 側の
  名前解決で `dp.home.arpa` も同じIPを指すこと
- **チューナードライバ** — mirakurun は `privileged: true` かつ `/dev/bus`・`/dev/dvb` を
  hostPath でマウントするので、ノード側にドライバが読み込まれていること
- **GHCR** — `ghcr.io/danything/mirakurun` と `.../denpa` を pull できること
  (imagePullSecrets 未設定)

## B-CASカードとデスクランブル

`recisdb` は**既定で ARIB STD-B25 を復号します**(`--no-decode` で無効化)。ただし
**カードが開けないときは黙って復号せずに素通しします**。録画は成功してサイズもそれらしい
のに中身が全部スクランブル、という分かりにくい壊れ方をします。エンコードのログには
音声フィルタのエラーしか出ないので原因が見えません。

対策として、`mirakurun/entrypoint.sh` で **`pcscd` を先に起動**してから Mirakurun を
起動し(ベースイメージに入っているが起動されない)、`tuners.yml` の recisdb に
**`-e` (`--exit-on-card-error`)** を付けてあります。カードが読めなければその場で失敗
させます。付けないと上記を静かに量産します。

### 直らないとき

`pcscd` が動いていてもリーダーが見つからないことがあります。`pcscd -f -d` を前面で
走らせるとどこで止まっているか分かります。

```text
hotplug_libudev.c:421:HPAddDevice() Adding USB device: Gemalto PC Twin Reader
ccid_usb.c:899:WriteUSB() write failed (4/3): LIBUSB_ERROR_TIMEOUT
```

**デバイスは見つかるが最初の書き込みがタイムアウトする**場合、リーダーが掴まれたまま
固まっています。USB レベルで入れ直すと戻ります(`4-11` は `lsusb` と
`/sys/bus/usb/devices` から引く)。

```sh
kubectl -n epg exec deploy/mirakurun -- pkill pcscd
echo 4-11 | sudo tee /sys/bus/usb/drivers/usb/unbind
sleep 2
echo 4-11 | sudo tee /sys/bus/usb/drivers/usb/bind
kubectl -n epg exec deploy/mirakurun -- bash -c 'pcscd; sleep 2; pcsc_scan -r'
```

確認のしかた:

```sh
# リーダーが見えるか。見えれば "0: Gemalto PC Twin Reader 00 00"
kubectl -n epg exec deploy/mirakurun -- pcsc_scan -r

# カードが読めるか。B-CAS なら ATR が返る
kubectl -n epg exec deploy/mirakurun -- bash -c 'timeout 8 pcsc_scan -n | head -12'

# 実際に復号できているか。0% なら正常、壊れていると 98〜99% になる
kubectl -n epg exec deploy/mirakurun -- bash -c '
  curl -s --max-time 10 "http://localhost:40772/api/services/<id>/stream?decode=1" > /tmp/s.ts
  perl -e "binmode STDIN; my (\$t,\$s)=(0,0);
    while (read(STDIN,\$b,188)==188) { last if substr(\$b,0,1) ne \"\x47\";
      \$t++; \$s++ if (ord(substr(\$b,3,1)) & 0xC0); }
    printf(\"packets=%d scrambled=%d (%.1f%%)\n\", \$t, \$s, \$t ? 100*\$s/\$t : 0);" < /tmp/s.ts'
```

## チャンネルスキャン

Mirakurun の Web UI (`http://<host>:40772/`) → 「チャンネル設定」右上の **Channel Scan**。
`Channel Type`(GR/BS/CS) と `Min/Max Channel` を指定します。既存の一覧を更新する形に
するため **Refresh (Update existing channels)** を有効にしてください。

recisdb はチャンネルの指定形式が違うので、**Use Channel Name Format** を有効にし、
**Channel Name Format** に GRなら `T{ch}`、CSなら `CS{ch}` を入れてから実行します
(BSは既定の `BS{ch00}_{subch}` のまま)。

目視の転記はミスの元なので、そのまま吸い出してリポジトリに上書きするのが確実です。

```sh
kubectl -n epg exec deploy/mirakurun -- cat /app-config/channels.yml > ./mirakurun/channels.yml
```

`git diff` で意図しない変更が無いか確認してから push してください。
`build-and-deploy.yml` が `mirakurun/*.yml` の変更を検知して再ビルド・再デプロイします。
