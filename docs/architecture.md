# 構成と設計

denpa がどう動くか、なぜそうしたか。使い方は [README](../README.md)、
denpa 内部の詳細は [app.md](app.md)。

## 全体

```text
チューナー ── mirakc ── denpa ── 録画(mkv) ─┬─→ VLC / Infuse (URLスキーム)
                                              └─→ Kodi (WebDAV)
```

メディアサーバは置きません。denpa がファイルをそのまま配り、再生は端末のプレイヤーに
任せます。ブラウザは MPEG-2 も AV1+Opus の mkv も素直には再生できないためです。

## チューナー側 (mirakc + エージェント)

mirakc は Mirakurun 互換ですが、足りないものが3つあります。どれもチューナーを持つ
コンテナでしか出来ないので、**mirakc の親としてエージェント (`mirakc/agent.ts`) を置き**、
そこで面倒を見ます。

- **チャンネルスキャン** — mirakc に走査APIがありません
- **設定の反映** — `config.yml` は起動時にしか読まれないので、書いたら再起動が要ります
- **B-CASカード** — pcscd 経由でしか読めず、その pcscd はあちらにしか居ません

設定は PVC に置きます (`/app-config/config.yml`)。**`/etc/mirakc` は使いません** —
あそこには mirakc 自身の `strings.yml` が居て、PVC を被せると隠れて起動しなくなります。

## チャンネルスキャン

**画面の「チューナー」から実行します。** Mirakurun の走査に合わせてあります。

- 地上波 13〜62ch を総当たり、BS は 01〜23 の各4スロット、CS は 02〜24ch
- 1チャンネル最大30秒。**NIT と SDT が両方揃って**初めて受信できたとみなします
  (SDT だけではどのネットワークのものか分からず、設定に書けません)
- 録るに値するサービス種別だけ残します
- チューナーの台数ぶん並べて回します。スキャン中は mirakc を止めてあるので
  取り合いになりません

うまくいかないときのために、失敗の理由は分けて出します。「そもそも何も来なかった」
(配線・デバイス指定を疑う) と「電波は来たのに NIT や SDT が揃わなかった」
(受信環境を疑う) では、次に見るところがまるで違うためです。recisdb が stderr に
書いたもの(「デバイスが使用中」など)も1行だけ添えます。**電波が来たのに揃わなかった
チャンネルだけ、もう一度回します** — NIT は10秒に1回しか流れてこないので、選局が
落ち着くのが遅れると待ち時間の中に1回も入らないことがあるためです。

選局コマンドは**プロセスグループごと**終わらせ、終わるのを待ってから次に行きます。
`sh -c` に渡すのがパイプラインだと、sh を殺しても recisdb が生き残ってチューナーを
掴んだままになり、以降のチャンネルが全部「受信できませんでした」になります。

局名は読みません。ARIB の文字符号を解くには外字や漢字集合まで面倒を見ることになりますが、
名前は mirakc が起動後に自分で拾います。

見つけたチャンネルだけ差し替え、**コメントと書式は残します**。チューナーの定義は
繋いである機材の話でスキャンでは分からないうえ、手で編集する設定ファイルだからです。
**1件も見つからなければ失敗**として扱い、今まで録れていた局を消しません。

スキャン後は mirakc の EPG キャッシュを捨てます。`services.json` にスキャン前の局が
残っていると、消えたはずの局が番組表に出続けます。

## 局ロゴ

**mirakc はロゴを TS から集めません**(設定でファイルを指す仕組みしかありません)。
denpa が録画で開いているストリームに相乗りして拾います。

ロゴは2つの表に分かれて流れてきます。CDT (PID 0x0029) に PNG の実体、SDT の
`logo_transmission_descriptor` に「どのサービスがどのロゴを使うか」。片方だけでは
紐付かないので、両方揃って初めて局に配ります。

拾えなかった局は、空いている時間に1局ずつ短く開いて取りに行きます。優先度を録画より
下げてあるので、チューナーが足りなければ mirakc が録画のほうを通します。


## B-CASカードとデスクランブル

`recisdb` は**既定で ARIB STD-B25 を復号します**(`--no-decode` で無効化)。ただし
**カードが開けないときは黙って復号せずに素通しします**。録画は成功してサイズもそれらしい
のに中身が全部スクランブル、という分かりにくい壊れ方をします。ログには音声フィルタの
エラーしか出ないので原因が見えません。

- エージェントが **`pcscd` を先に起動**します (ベースイメージに入っているが起動されない)
- **録画は止めません。** 電波は二度と戻ってこないので、スクランブルされたままでも
  録っておきます。denpa がエンコードの前に見て、掛かったままならそこで解きます
  (`src/lib/server/scramble.ts`)
- **解くのはチューナー側のエージェントです。** カードは pcscd 経由でしか読めず、
  その pcscd は向こうのコンテナにしか居ません。socket を共有して denpa から
  直接読ませていた頃は、カードを開けないままでした
- やり取りするのは**パスだけ**です。生TSの置き場 (`denpa-recorded`) を両方のコンテナに
  見せてあるので、読むのも書くのも向こうが直接やります。数十GBを HTTP で往復させません
  (**両方の Pod が同じノードに居ることが前提**です)
- **生TSを残す設定のときは、残るのは解除済みのTSだけ**です。掛かったままのものを
  取っておいても、あとから解ける保証はありません
- 状態は**チューナー画面の「つながり具合」**に出ます (mirakc のバージョンと
  カードリーダーが見えているか)

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
kubectl -n epg exec deploy/mirakc -- pkill pcscd
echo 4-11 | sudo tee /sys/bus/usb/drivers/usb/unbind
sleep 2
echo 4-11 | sudo tee /sys/bus/usb/drivers/usb/bind
kubectl -n epg exec deploy/mirakc -- bash -c 'pcscd; sleep 2; pcsc_scan -r'
```

確認は次の3つ。リーダーが見えるか、カードが読めるか(B-CAS なら ATR が返る)、
実際に復号できているか(0% なら正常、壊れていると 98〜99%)。

```sh
kubectl -n epg exec deploy/mirakc -- pcsc_scan -r
kubectl -n epg exec deploy/mirakc -- bash -c 'timeout 8 pcsc_scan -n | head -12'
kubectl -n epg exec deploy/mirakc -- bash -c '
  curl -s --max-time 10 "http://localhost:40772/api/services/<id>/stream?decode=1" > /tmp/s.ts
  perl -e "binmode STDIN; my (\$t,\$s)=(0,0);
    while (read(STDIN,\$b,188)==188) { last if substr(\$b,0,1) ne \"\x47\";
      \$t++; \$s++ if (ord(substr(\$b,3,1)) & 0xC0); }
    printf(\"packets=%d scrambled=%d (%.1f%%)\n\", \$t, \$s, \$t ? 100*\$s/\$t : 0);" < /tmp/s.ts'
```


## 録画の置き場と視聴

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
端末のプレイヤーを起動します。番組名はどの端末にも渡します。

| 端末 | 渡し方 | 必要なもの |
| --- | --- | --- |
| Windows | `denpa://play/<base64url>/?title=<base64url>` | VLC と [windows/denpa.ps1](../windows/denpa.ps1) での登録 |
| Mac | 同上 | VLC と [mac/denpa.sh](../mac/denpa.sh) での登録 |
| Android | `intent://...action=VIEW;type=video/*` | 動画が再生できるアプリ(端末が選択画面を出す) |
| iOS / iPadOS | `vlc-x-callback://` | VLC |
| その他 | 素のURL | 好きなプレイヤーに貼る |

**「どのアプリで開くか選ばせる」ことができるのは Android だけ**です。アプリを名指し
すると入っていないときに何も起きないうえ好みも人それぞれなので、Android では端末に
選ばせます。他の端末にこれに当たる仕組みは無く(iOS の共有シートはリンクからは
呼べません)、スキームを直に叩くしかないので VLC 決め打ちです。

Windows と Mac は VLC 自身がスキームを持たないので、`denpa://` を自前で用意して
登録します。リンクの形は両者で同じで、受け口だけが違います。

iPadOS は User-Agent で Macintosh を名乗るので、`navigator.maxTouchPoints` まで見て
Mac と分けています(渡す先が違うため)。

配信は `/api/recordings/<id>/file`。Range に対応しているのでプレイヤー側から早送り
できます。エンコード済みがあればそれを、無ければ生TSを返します。

Kodi からは `/dav` を **WebDAV サーバー**として追加するとフォルダ構成そのままで開けます
(Android TV や Fire TV の Kodi も同じです)。
`.nfo` とサムネイルが動画の隣にあるので番組名・概要・放送局・サムネイルも出ます。
**削除も受けます**(denpa の画面から消したときと同じ道を通るので、DBもすぐ揃います)。
消せるのは denpa が知っている録画だけで、フォルダごとや手で置いたファイルは断ります。
置く側 (PUT / MKCOL / COPY / MOVE) は受けません。

### ベーシック認証

VLC も Kodi もリダイレクト型の認証を扱えないので、**ファイルを取りに来る口だけ**に
かけられるようにしてあります。**設定画面から入れます**(環境変数
`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` / `BASIC_AUTH_SCOPE` は初期値としても
使えますが、画面の値が勝ちます)。

- ユーザー名とパスワードの**両方**が入っているときだけ有効
- 「配信と WebDAV だけ」(既定)… `/api/recordings/<id>/file` と `/dav`。画面は素通し
- 「画面も含めて全部」… すべてのパス

再生リンクとダウンロードの URL には資格情報を埋め込みます
(`http://user:pass@.../file`)。プレイヤーは認証ダイアログを出せないものが多く、
ブラウザもページの認証をダウンロードに引き継がないためです。

> **注意**: 既定では録画一覧の画面自体に認証がかかりません。画面を開けば再生リンクの
> 中のパスワードも見えるので、**画面の前段に別の認証を置いている前提**の設定です。

### 削除

**denpa の画面から**行います(押し間違い防止に2回押させます)。自動削除はありません。

**WebDAV 経由の削除**も同じ扱いで、消した時点で一覧に反映されます。

ファイルマネージャなど denpa を通さずに消された場合だけは気づけないので、
`RECONCILE_INTERVAL`(既定5分)ごとの突き合わせで拾います。残った `.nfo` / サムネイルと
空フォルダも片付けます。すぐ反映したいときは「実体と照合」。

> inotify (`fs.watch`) で消した瞬間に拾えないか試しましたが、この構成 (bun + vite dev) では
> **最初の1件しかイベントが来ず**当てにできなかったので定期実行のままにしています。


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
消えるので無音だけより格段に確かです。本体は Windows + AviSynth+ 前提ですが検出核には
[Linux 移植](https://github.com/tobitti0/JoinLogoScpTrialSetLinux)があり、denpa は
その成果物 (`Trim()` の並んだ avs) を読むだけなのでエンコードは ffmpeg のままです
(`src/lib/server/cm-jls.ts`)。使うにはイメージに `chapter_exe` / `logoframe` /
`join_logo_scp` と AviSynth+ 3.5.x、**局ごとのロゴデータ (`.lgd`)**、`CM_DETECTOR=jls` と
`CM_JLS_COMMAND` が要ります。移植は 2020 年で止まっていてロゴの用意も手間なため既定は
`silence` です。検出できなければ無音検出に落ちます。


## 通知

録画の節目を Webhook で外に飛ばせます。設定画面から追加してください(Discord や Slack の
Incoming Webhook の URL をそのまま入れられます)。

- 録画開始 / 録画完了 / 録画失敗 / エンコード完了 / エンコード失敗。選ばなければ全部
- **送信は投げっぱなし**です。通知先が遅いせいで録画が止まるほうが困るので、10秒で
  打ち切って結果だけ記録します。直近の結果は設定画面に出ます
- 録画の失敗は画面を開くまで気づけないので、**少なくとも失敗だけでも**入れておくのを勧めます


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
決めて古い側から捨てます(生TSは約6.6GB/時)。同じチャンネルなので mirakc 側で
チューナーは共有され、増えるのはディスク書き込みだけです。番組の頭までの余分は
エンコード時に `-ss` で落とします。

## クラスタ側の前提条件

このリポジトリには `epg` namespace のアプリ本体しか入っていません。k3sホストの初期構築や
共通アドオンは別の(プライベートな) bootstrap リポジトリ側です。適用前に以下が要ります。

- **StorageClass `local-path-retain`** — `reclaimPolicy: Retain` の local-path
- **`auth` namespace の Traefik Middleware** — `forward-auth`
- **Traefik** — `mydnschallenge` certResolver (Cloudflare DNS-01)、
  `allowCrossNamespace: true`、および http→https リダイレクトが `doany.io` 系だけに
  限定されていること (bootstrap の `traefik/redirect-https.yaml`)。`web` エントリポイント
  全体にかけると `dp.home.arpa` も飛ばされます
- **ArgoCD** — push時に webhook が自動登録される運用。Application 自体はクラスタの
  state.db バックアップから復元される前提でマニフェストとしては存在しません
- **DNS** — `m.doany.io` / `dp.doany.io` が Traefik の外部IPを、LAN 側の名前解決で
  `dp.home.arpa` も同じIPを指すこと
- **`PROTOCOL_HEADER=x-forwarded-proto`** — SvelteKit の CSRF 判定は Origin ヘッダと
  自分の origin を突き合わせるが、adapter-node は `ORIGIN` も `PROTOCOL_HEADER` も
  無いと **https と決め打つ**ため、平文の `dp.home.arpa` からの POST が全部 403 に
  なる(画面上は「押しても何も起きない」に見える)
- **チューナードライバ** — mirakc は `privileged: true` かつ `/dev/bus`・`/dev/dvb` を
  hostPath でマウントするので、ノード側にドライバが読み込まれていること
- **GHCR** — `ghcr.io/danything/mirakc` と `.../denpa` を pull できること
