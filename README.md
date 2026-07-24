# k3s epg

このディレクトリには EPG スタックの k3s マニフェストとローカルファイルが置かれています。

## チャンネルスキャン

`recisdb` でチューナーデバイスを直接叩くスクリプトなので、稼働中の `mirakc` pod に
exec して動かすと、mirakc自身の背景ジョブ(scan-services/sync-clocksなど)と同じ
チューナーを取り合って衝突・タイムアウトの原因になります。なので専用の一時Pod
(`mirakc/scan-pod.yaml`)を使い、その間 mirakc 本体は止めてしまいます(録画は
止まるので、実行前に録画中でないか必ず確認してください)。一時Podは毎回作り直す
ので、直前に `scan.sh` を編集していても確実に最新の内容で動きます。

```sh
kubectl -n epg exec deploy/mirakc -- curl -sf http://epgstation.epg.svc.cluster.local:8888/api/recording | jq '.records[] | select(.isRecording)'

kubectl -n epg scale deployment/mirakc --replicas=0
kubectl apply -f mirakc/scan-pod.yaml
kubectl -n epg wait --for=condition=Ready pod/scan-tuner --timeout=30s
kubectl -n epg exec -it pod/scan-tuner -- ./scan.sh
```

`scan.sh` は見つかったチャンネルで `config.yml`(コンテナ内では
`/etc/mirakc/config.yml`)の `channels:` ブロックを丸ごと置き換えます(ファイル内の
位置はそのまま、`tuners:`/`resource:`など他のセクションには触れません)。

終わったら一時Podを片付け、mirakcを起動し直します(EPGキャッシュも念のため
消してクリーンに再構築させます):

```sh
kubectl -n epg delete -f mirakc/scan-pod.yaml
sudo rm -f /home/ruk/k3s/epg/mirakc/epg/*.json
kubectl -n epg scale deployment/mirakc --replicas=1
kubectl -n epg rollout restart deployment/epgstation
```

## 局ロゴの取得

mirakc は放送波からロゴ画像を自動抽出する機能を持っていません。`config.yml` の
`resource.logos` に明示的に列挙した画像だけを配信します。通常は下記「ロゴ収集の
定期実行」の CronJob が自動で収集・反映しますが、手動ですぐに再生成したい場合は
以下の手順で実行してください。

```sh
kubectl -n epg exec -it deploy/mirakc -- sh
./collect-logos.sh
```

```sh
COLLECT_SECONDS=600 CHANNELS="GR/27 BS/BS15_1" ./collect-logos.sh
FORCE=1 ./collect-logos.sh   # 既存ファイルを無視して全部取り直す
PARALLEL_GR=1 PARALLEL_BSCS=1 ./collect-logos.sh   # 他の録画などでチューナーを取り合う場合は1に落とす
```

既に取得済みのロゴも、ファイルの更新日時が `REFRESH_DAYS`(既定7日、Mirakurunの
`logoDataInterval`と同じ考え方)より古くなったら自動的に「未取得」扱いに戻って
再収集の対象になります(局がロゴを変更した場合に追従するため)。`FORCE=1` は
経過日数に関係なく問答無用で全部取り直します。

実行が終わると `config.yml`(コンテナ内では `/etc/mirakc/config.yml`)の
`resource.logos` を直接書き換えます。この手動実行の経路では反映に mirakc の
再起動が必要です:

```sh
kubectl -n epg rollout restart deployment/mirakc
```

## ロゴ収集の定期実行

BS/CSは局ロゴの送信自体が低頻度・不定期(局によっては全く送信されない期間もある)
で、1回の `collect-logos.sh` 実行だけでは取り切れないことがあります。そこで
`cronjob.yaml` の CronJob(`collect-logos`, epg namespace)が30分おきに
自動でリトライします。

BS/CSはARIB TR-B15により全局のロゴが1つの共有「エンジニアリングサービス」に
相乗りして流れてくる(Mirakurunも同じ仕組みを利用しています)ので、既定では
36局全部を個別にチューニングせず、代表として `BSCS_REPRESENTATIVE_COUNT`
(既定2)局のBSチャンネルだけを `BSCS_COLLECT_SECONDS`(既定1500秒)張って、
そこに乗ってくる他局分も含めて拾います。`CHANNELS` を明示指定した場合はこの
省略ロジックを使わず、指定したチャンネルをそのままチューニングします。全BS/CS
のロゴが既に揃っている場合はこのステップ自体をスキップします。

- `mirakc/scheduled-collect-logos.sh` が本体で、実行前に epgstation の
  `/api/recording` と `/api/reserves` を見て、録画中または30分以内に録画が
  始まる場合はその回をまるごとスキップします(`LOOKAHEAD_MINUTES` で調整可)。
  同様に mirakc 自身の EPG 収集ジョブ(`config.yml` の `jobs:` にある
  `scan-services`/`sync-clocks`/`update-schedules`、全番組情報の取得はこれが
  担っています)が `/api/tuners` 上でチューナーを掴んでいる間もこの回を
  スキップし、番組情報の取得を優先します。
- 逆に `collect-logos.sh` が先にチューナーを掴んでいる状態で mirakc 側の
  EPG ジョブの実行タイミングが来た場合に備えて、`collect-logos.sh` の
  ストリーム要求には `X-Mirakurun-Priority: -2`(`STREAM_PRIORITY` で調整可)
  を付けています。mirakc の内部ジョブは優先度 `-1` で動いており、チューナーは
  「後から要求した側の優先度が高いときだけ」奪えるため、常にこのジョブ側が
  `collect-logos.sh` からチューナーを奪い返せます(奪われた側は単に
  ロゴデータを取得できなかった扱いになるだけで、次回以降の実行でリトライ
  されます)。
- 競合がなければ `collect-logos.sh` を呼び出しますが、`MAX_RUNTIME_SECONDS`
  (既定1700秒)で全体に時間制限をかけていて、次のスケジュールに食い込む前に
  打ち切ります。打ち切られても収集済み分はスキップされるので、次回以降の
  実行で少しずつ続きが進みます。
- mirakc pod を直接 exec するのではなく、`localhost/epg-mirakc:latest` の
  別podとしてmirakcのHTTP API・epgstationのHTTP APIにネットワーク越しで
  アクセスします。`config.yml` とロゴ画像はmirakc podと同じhostPathを
  マウントして共有しています。
- `config.yml` が実際に変化した(新しいロゴが収集できた)場合のみ、直前に
  もう一度 `/api/recording` を確認したうえで mirakc の Deployment を自動で
  再起動します。専用の ServiceAccount(`collect-logos`)に、この Deployment
  だけを対象にした `get`/`patch` 権限を RBAC (`Role`/`RoleBinding`) で
  付与しています。収集直後に録画が始まっていた場合は再起動をスキップし、
  次回以降の再起動時にまとめて反映されます。

適用/削除:

```sh
kubectl apply -f cronjob.yaml
kubectl -n epg delete cronjob collect-logos   # 止めたい時(ServiceAccount/RBACも削除されます)
```

```sh
kubectl -n epg get jobs                          # 実行履歴
kubectl -n epg logs job/<job名>                  # 各回のログ(スキップ理由・再起動有無など)
```

## 補足

- `mirakc/config.yml` が現在有効な k3s 上の設定ファイルです。
- `mirakc/channnels.conf` はチューナーアクセス用に稼働中の pod にマウントされています。
- `mirakc/logos/` には抽出済みの局ロゴが置かれます。`resource.logos` は `collect-logos.sh` が `mirakc/config.yml` に直接書き込みます。詳細は上記「局ロゴの取得」「ロゴ収集の定期実行」を参照してください。
- ビルド元ファイルは `build/` 以下にあり、サーバー上で直接編集してください。
- `mirakc/*.sh` や `mirakc/config.yml` は hostPath の単一ファイルマウント(`type: File`)で
  稼働中の mirakc pod に渡されています。ファイルを書き換えると新しい inode に差し替わりますが、
  既に起動済みの pod は起動時に掴んだ古い(既に削除済みだが握りっぱなしの) inode を見続けるため、
  `kubectl exec` で入って中身を見ても変更が反映されていないことがあります。`scan.sh` や
  `collect-logos.sh` など pod 内で直接実行するスクリプトを編集したら、実行前に
  `kubectl -n epg rollout restart deployment/mirakc` して新しい pod に掴み直させてください。
