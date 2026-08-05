# 構成と設計

**「なぜそうしたか」を書く場所。** 迷ったところ、踏んだ落とし穴、選ばなかった案。
全体像はここに置き、**機能ごとの話はそれぞれの文書**にあります。

| 探しもの | 見る場所 |
| --- | --- |
| 入れ方・使い方 | [README](../README.md) |
| **全体像・入れ替え・クラスタ前提** (ここ) | この文書 |
| チューナーを掴むところ (エージェント・取り合い・相乗り・B-CAS) | [agent.md](agent.md) |
| CM とエンコード (字幕・AV1・CM検出・コマ数) | [encode.md](encode.md) |
| 局ロゴ (番組表用の PNG と CM検出用の `.lgd`) | [logo.md](logo.md) |
| 録画の置き場と配り方 (保存先・認証・削除・通知) | [library.md](library.md) |
| エージェントに聞くもの / denpa が持つもの (番組表・スキャン・予約) | [data.md](data.md) |
| どこに何があるか (ファイル・環境変数・画面・DB) | [app.md](app.md) |
| EPGStation からの引き継ぎ | [migrate.md](migrate.md) |
| ライブ視聴の設計 (未実装) | [stream.md](stream.md) |
| これからやるもの | [roadmap.md](roadmap.md) |

コードの置き場や設定名はここには書きません (app.md と二重に持つと必ず片方が古くなる)。

## 全体

```text
チューナー ── エージェント ── denpa ── 録画(mkv) ─┬─→ VLC / Infuse (URLスキーム)
                                                    └─→ Kodi (WebDAV)
```

メディアサーバは置きません。denpa がファイルをそのまま配り、再生は端末のプレイヤーに
任せます。ブラウザは MPEG-2 も AV1+Opus の mkv も素直には再生できないためです。

**境界は「電波を掴むところ」と「中身を読むところ」で切ってあります。** エージェントは
チャンネルを掴んで素の TS を流すだけで、NIT も SDT も EIT も解きません。局を選り分ける
のも、番組表を組み立てるのも、ロゴを拾うのも denpa です ([agent.md](agent.md))。

## 入れ替えと録画

ArgoCD が同期すると Pod が差し替わります。録画中に来ても困らないように、
**denpa は SIGTERM を受けても録画が終わるまで居座ってから止まります**
(`SHUTDOWN_WAIT`、既定6時間)。待っている間は新しい録画を始めません。

TSは追記で開いていて、次の起動で `recoverOrphanedRecordings` が続きから録り直すので、
落ちても丸ごと失うことはありません。それでも居座るのは、**入れ替わるまでの
十数秒はどうやっても落ちる**からです。ArgoCD の同期は待てますが、放送は待ちません。

**待っている間も画面は開けます。** ここは2箇所で落ちていました。

1. **adapter-node が SIGTERM を受けたその場で listen を閉じる。** 居座っている間、
   Pod の中からも `127.0.0.1:3000` が拒否される状態でした。止まれの合図は
   `takeOverSignals` でこちらが受け取り、先に入っていた後始末は外します。
   閉じるのは本当に止まる直前 (`process.exit`) だけです。

   **引き取りは1回では足りません。** あちらが登録するのは `build/index.js` の
   いちばん最後で、こちらはその手前 (`hooks.server.ts` はアプリの読み込みで走る)
   なので、**最初の引き取りでは外すものがまだ無い**。そのまま置くと両方が
   登録された状態になり、プロセスは生きたまま**ポートだけ閉じます** — 実機で
   `/proc/net/tcp` に listen が1つも無く、Traefik が「no available server」を
   返しているのに、番組表は集まり続けている状態を確認しました。
   `setImmediate` でもう一度引き取り直します。

   **2度目の合図でも落ちないようにします。** `once` で受けていた頃は、1度目で
   自分の後始末が外れて**誰も聞いていない**状態になり、デプロイがもう一度走ると
   Node の既定どおり録画の途中でも終わっていました。
2. **Kubernetes は `deletionTimestamp` が付いた Pod を Service から外す。**
   EndpointSlice には住所が残りますが `ready:false` / `terminating:true` になり、
   kube-proxy が回さなくなります。Service に `publishNotReadyAddresses: true` を
   付けると `ready:true` に戻ります。この Deployment に readinessProbe は無く、
   `strategy: Recreate` で新旧の Pod が並ぶこともないので、副作用はありません。

実機では、録画中に同期が来て**34分間ずっと画面だけ開けない**状態になりました
(Pod は生きていて録画も無事)。

居座っている間は**新しい録画を始めません**。この間に入れた予約は、Pod が入れ替わった
あと新しいほうが拾います (録画が終わればすぐ入れ替わるので、待つのは数分です)。

録画していないときは即座に止まるので、普段の入れ替えはこれまでどおりです。
すぐ入れ替えたいときは `SHUTDOWN_WAIT=0` にすると、以前と同じ「落ちて、
続きから録り直す」に戻ります。

Kubernetes の `terminationGracePeriodSeconds` と docker compose の
`stop_grace_period` を `SHUTDOWN_WAIT` より長くしておくこと。短いと待っている
途中で SIGKILL され、居座った意味が無くなります。

### 隙間はイメージの取得時間だった

新旧の Pod を並べられないので、入れ替えの隙間はどうやっても空きます。実機で
その中身を測ると、**ほとんどがイメージの取得**でした。

```text
ScalingReplicaSet (旧Podを削除) → Pulling → Pulled 13.6秒 → Started → bun 起動
```

そこで、**マニフェストを当てる前にイメージだけ引いておく** Job を ArgoCD の
PreSync フックに置いています (`denpa-prepull`、中身は `/bin/true`)。
これで入れ替えのときには `imagePullPolicy: IfNotPresent` が効いて取得が要らなくなり、
隙間は起動そのものだけになります。イメージのタグは CI が `k3s/deployment.yaml` を
まるごと `sed` で書き換えるので、この Job のぶんも自動で揃います。

**録画そのものを引き継ぐことはしていません。** 引き継ぐには新旧のPodが同時に
居る必要がありますが、denpa は1本のSQLiteに書き、スケジューラもEPG取得も
エンコード待ち行列も抱えているので、2つ動くと全部が二重になります
(どちらが主かを決める仕組みが別途要る)。
**録画をエージェント側に持たせる**道もあります。そうすれば denpa の入れ替えと
録画が切り離れますが、番組追従・スクランブル解除・保存名の付け方まであちらへ
移すことになり、「エージェントは中身を読まない」という切り分けが崩れます。
**この道は選びません。**

## ライブ視聴

**denpa はまだ実装していません。**

**mirakc をやめたことで、その場しのぎの道も無くなりました。** それまでは mirakc の
IPTV 向けの口 (`/api/iptv/playlist` と `/api/iptv/xmltv`) を Kodi の
PVR IPTV Simple Client に食べさせれば、番組表付きのライブTVになっていました。
エージェントは局も番組表も知らないので、あの口はどこにもありません。

**代わりを作るなら denpa 側です。** 局の一覧も番組表も denpa が持っているので、
M3U8 と XMLTV を出すこと自体は難しくありません (むしろ、ベーシック認証も
予約との取り合いもそのまま効くので、あちらの口より筋が良いはずです)。

録画済みのものを Kodi で観るのは denpa の `/dav` です。こちらは別物で、denpa の
認証も削除も効きます。

denpa 側に作るとしたらどうするか、なぜ外のメディアサーバに任せないのかは
[stream.md](stream.md) にまとめてあります。要点は「視聴・追っかけ録画・チューナーの
取り合いを1箇所で決めたい」で、視聴中は常に生TSをバッファに書いておき、途中で
「やっぱり録る」と決めても番組の頭から残せるようにする、という設計です。

## クラスタ側の前提条件

このリポジトリには `denpa` namespace のアプリ本体しか入っていません。k3sホストの初期構築や
共通アドオンは別の(プライベートな) bootstrap リポジトリ側です。適用前に以下が要ります。

- **StorageClass `local-path-retain`** — `reclaimPolicy: Retain` の local-path
- **`auth` namespace の Traefik Middleware** — `forward-auth` と
  **`forward-auth-errors` の両方**。後者が無いと、まだログインしていない端末に
  素の 401 が返って「Unauthorized」としか出ません (ログイン画面へ行けない)
- **Traefik** — `mydnschallenge` certResolver (Cloudflare DNS-01)、
  `allowCrossNamespace: true`
- **ArgoCD** — push時に webhook が自動登録される運用。Application 自体はクラスタの
  state.db バックアップから復元される前提でマニフェストとしては存在しません
- **DNS** — `m.doany.io` / `dp.doany.io` が Traefik の外部IPを指すこと。
  LAN 用の `dp.l.doany.io` は `*.l.doany.io` の書き換えで内側のIPへ
- **`PROTOCOL_HEADER=x-forwarded-proto`** — SvelteKit の CSRF 判定は Origin ヘッダと
  自分の origin を突き合わせるが、adapter-node は `ORIGIN` も `PROTOCOL_HEADER` も
  無いと決め打ちになる。名前が2つある (`dp.doany.io` と `dp.l.doany.io`) ので
  `ORIGIN` は使えず、リクエストごとに Traefik の付けたヘッダを見る
- **チューナードライバ** — エージェントは `privileged: true` かつ `/dev/bus`・`/dev/dvb` を
  hostPath でマウントするので、ノード側にドライバが読み込まれていること
- **GHCR** — `ghcr.io/danything/denpa-agent` と `.../denpa` を pull できること
