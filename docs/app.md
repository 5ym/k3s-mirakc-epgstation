# どこに何があるか

**索引。** ファイル・環境変数・画面・状態遷移・テストの入口をまとめてある。

**「なぜそうなっているか」はここには書かない。** 理由は
[architecture.md](architecture.md) に置く (両方に書くと必ず片方が古くなる)。
迷ったら「これは何」ならここ、「なぜこれ」なら architecture.md。

mirakc から EPG と TS を受け取り、予約・録画・エンコード・保存先への配置までを行う。
出来上がった mkv は保存先に置かれ、denpa が配って外部プレイヤーで見る。削除は手動。
EPGStation の置き換えとして作ったもので、エンコード設定はそこから移した。

## 構成

| ファイル | 役割 |
| --- | --- |
| `src/lib/server/mirakc.ts` | mirakc の API クライアント |
| `src/lib/server/mirakc-events.ts` | mirakc からの知らせ (`/events`) の購読 |
| `src/lib/server/epg.ts` | 番組表の取り込みと予約時刻の追従 |
| `src/lib/server/rules.ts` | ルール(キーワード/チャンネル/ジャンル)から予約を作る |
| `src/lib/server/reservations.ts` | 手動予約と取り消し |
| `src/lib/server/conflict.ts` | チューナー割り当てと競合判定 (純粋関数) |
| `src/lib/server/scheduler.ts` | 予約 → 録画の状態遷移 |
| `src/lib/server/recorder.ts` | TS の受信とファイル書き出し |
| `src/lib/server/cm.ts` | CM検出 (無音 + CM尺) |
| `src/lib/server/cm-jls.ts` | CM検出 (join_logo_scp。任意) |
| `src/lib/server/encoder.ts` | 録画のエンコード (AV1 / H.264) |
| `src/lib/server/subtitle.ts` | ARIB字幕を絵にして `.sup` にする (sub2video) |
| `src/lib/pgs.ts` | PGS (Blu-ray の字幕) の組み立て。ffmpeg に符号器が無いので自前 |
| `src/lib/play.ts` | 外部プレイヤーを開くURLの組み立て |
| `src/lib/server/library.ts` | 保存先でのファイル配置 |
| `src/lib/server/metadata.ts` | .nfo とサムネイル (Kodi など向け) |
| `src/lib/server/files.ts` | 録画の削除と、実体とDBの突き合わせ |
| `src/lib/server/serve.ts` | ファイルの配信 (Range 対応) |
| `src/lib/server/scramble.ts` | スクランブルの検出と、チューナー側への解除依頼 |
| `src/lib/server/scan.ts` | チャンネルスキャン (チューナー側に投げて進み具合を読む) |
| `src/lib/server/logo.ts` | 局ロゴの収集と保存 (番組表に出すPNG) |
| `src/lib/components/LogoArea.svelte` | CM検出用のロゴ位置を画面から教える |
| `src/lib/ts/psi.ts` | TS の PSI (NIT / SDT) を読む。チューナー側と共通 |
| `src/lib/ts/logo.ts` | TS から局ロゴ (CDT) を読む |
| `src/lib/ts/logo-palette.ts` | 局ロゴPNGに ARIB の色の表 (PLTE/tRNS) を入れ直す |
| `src/lib/ts/synth.ts` | TS のセクションを組み立てる (テストと偽mirakc用) |
| `src/lib/server/migrate.ts` | EPGStation からの引き継ぎ |
| `src/lib/server/dav.ts` | WebDAV (Kodi 向け) |
| `src/lib/server/auth.ts` | ベーシック認証 |
| `src/lib/server/events.ts` | 画面へ変化を知らせる (SSE。ポーリングの代わり) |
| `src/lib/server/webhook.ts` | 録画の節目を外部へ通知する |
| `src/lib/server/runtime.ts` | 常駐処理の起動 (hooks.server.ts から呼ばれる) |
| `src/lib/server/config.ts` | 環境変数 |
| `src/lib/server/settings.ts` | 画面から変えられる設定 (環境変数を初期値にDBで上書き) |
| `src/lib/server/db.ts` / `schema.ts` | SQLite と スキーマ |

## 状態遷移

```
予約 scheduled ─(開始時刻)→ started_at が入る ─→ あとは録画の行が持つ
      ├(チューナー不足)→ conflict
      ├(手で取り消し)→ canceled
      └(始まらないまま放送終了)→ missed

録画 recording ─→ recorded ─→ available ─(削除)→ deleted
                                  └(録画そのものの失敗)→ failed
```

**状態は列として持ちません。** 持っているのは事実だけで、そこから毎回決めます。

| 見せる状態 | 何から決まるか |
| --- | --- |
| `recording` | `recordings.finished_at` がまだ NULL (=チューナーを掴んでいる) |
| `recorded` | 録り終えたが保存先にはまだ無い |
| `available` | `library_path` が入っている |
| `failed` | `recordings.error` が入っている (**録画そのものの失敗だけ**) |
| `deleted` | `deleted_at` が入っている |
| エンコード中 / エンコード失敗 | `encode_jobs` の最新の1件 (録画の状態には混ぜない) |

`recordings.state` は SQLite の**生成列**です (`schema.RECORDING_STATE`)。書き込もうとすると
SQLite が拒むので、事実と状態が食い違いようがありません。文字列で別に持っていた頃は、
**エンコードの失敗が録画そのものの失敗として書き込まれ**、中身のある生TSを持ったまま
再生もダウンロードもできなくなっていました。予約側も同じで、`recording` / `done` /
`failed` を書き写していたために、録画が失敗しても予約は録画中のまま残ることがありました。

チューナーの本数を数えるときは、番組の時刻ではなく前後マージンを足した
「実際に掴んでいる区間」で重なりを見ます。22:00 終了と 22:00 開始は実際には重なるので、
ここを揃えないと予約表では通っているのに実行時に録り逃します。

録画中にプロセスが落ちた場合、次の起動でまだ放送中なら録り直します。生TSは追記で
開くので、落ちるまでに録れていた分は残ります。放送が終わっていれば失敗に倒します。

DBは SQLite 1ファイル (`DENPA_DB`)。スキーマは `src/lib/server/schema.ts`。

## 環境変数

**外から差し替える理由があるものだけ。** 相手の居場所と、テストで詰めたい間隔だけです。
検出のしきい値やサムネイルの大きさまで環境変数にしていた頃は、誰も触らないのに
「触れる」ぶん既定値の出どころが追いにくくなるだけでした
(`src/lib/server/config.ts` に直に書いてあります)。

**画面から変えたいものは設定画面** (`src/lib/server/settings.ts`)。コーデック・CMの扱い・
CMの探し方・エンコードするか・生TSを残すか・無料放送だけか・ベーシック認証がここです。

k3s の manifest には `PROTOCOL_HEADER` と `ENCODE_CONCURRENCY` しか書いていません。
残りは既定値がそのままあの構成なので、同じ値を書き写すと片方だけ直したときに
どちらが効いているのか分からなくなります。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `MIRAKC_URL` | `http://mirakc:40772` | mirakc |
| `TUNER_AGENT_URL` | `http://mirakc:40773` | チューナー側のエージェント (スキャン・カード・解除) |
| `DENPA_DB` | `/app/data/denpa.db` | SQLite の置き場。局ロゴと `.lgd` もこの隣 |
| `RECORDED_DIR` | `/app/recorded` | 生TSの作業領域 |
| `LIBRARY_DIR` | `/library` | エンコード済みの置き場。ここから配る |
| `FFMPEG` / `FFPROBE` | `/usr/local/bin/...` | 開発時は偽物に差し替える |
| `ENCODE_CONCURRENCY` | `1` | 録画エンコードの同時実行数。ライブ配信の本数とは無関係 |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | `denpa` / (空) | 初期値。パスワードが入っているときだけ有効 |
| `BASIC_AUTH_SCOPE` | `files` | 初期値。`files` … 配信と WebDAV だけ / `all` … 画面も含めて全部 |
| `START_MARGIN` / `END_MARGIN` | `10000` / `15000` | 録画の前後マージン(ms)。放送に追従しているときは mirakc 側が切れ目を決める |
| `SCHEDULER_TICK` | `5000` | 予約チェックの間隔(ms) |
| `RECONCILE_INTERVAL` | `300000` | 保存先の実体とDBを突き合わせる間隔(ms) |
| `EPG_SYNC_INTERVAL` | `600000` | EPG取得の間隔(ms)。保険 (合図は mirakc の `/events`) |
| `EPG_EVENT_DEBOUNCE` | `10000` | 知らせが来てから取り直すまで(ms)。局の数だけ連続で飛んでくるため |
| `ONAIR_POLL_INTERVAL` | `300000` | 放送の延長を見に行く間隔(ms)。これも保険 |
| `ONAIR_FALLBACK_WAIT` | `90000` | 番組単位で開いて何も来ないとき、サービス単位に切り替えるまで(ms) |
| `SHUTDOWN_WAIT` | `21600000` | 止められたとき、録画が終わるまで待つ上限(ms)。`0` で待たない |
| `EPGSTATION_*` | — | 引き継ぎ元の DB と録画置き場 |
| `DENPA_AUTOSTART` | `1` | `0` で常駐処理を止める |

## 画面

| 画面 | 役割 |
| --- | --- |
| `/` | **予約と録画**を2ペインで並べる。**録画の行を押すと再生**、中身は「詳細」から。行の形はどの画面幅でも同じで、狭いところでは押すものが下へ回り込む。生TSを残しているときは大きさを両方出す (`43 MB (生TS 594 MB)`)。**エンコードの失敗では再生もダウンロードも消さない** — 落ちたのは焼き直しのほうで、生TSは無事 |
| `/guide` | 番組表(グリッド)と番組検索。マスはジャンルごとに色を変える。詳細から予約・取消と、録れているものはそのまま再生できる |
| `/rules` | 自動予約ルールの一覧と作成 |
| `/tuners` | チャンネルスキャン (途中で中断できる)、局の取り直し、チューナーの空き、取れているチャンネル (mirakc 側の局と番組表の集まり具合つき)、mirakc とカードリーダーと局ロゴの状態 |
| `/settings` | 録画のしかた(コーデック/CMの扱い/CMの探し方/エンコードするか/生TSを残すか/無料放送だけか)、通知先(Webhook)、ベーシック認証(パスワードの表示と作り直し)、EPGStation からの引き継ぎ |
| `/api/recordings/<id>/file` | 録画ファイル。Range 対応。**エンコード済みがあればそちら、無ければ生TS。エンコードが走っている間は生TSのほう** (録り直しの最中は library_path がまだ古いファイルを指していて、しかもそれは終わり際に消える) |
| `/api/recordings/<id>/frame?at=<秒>` | 録画から1コマ (JPEG)。ロゴの位置を指定するときに使う |
| `/dav` | WebDAV (PROPFIND / GET / HEAD)。Kodi 用。書き込みは受けない |

## チューナー側 (`mirakc/`)

mirakc の親として動くエージェント。なぜ親を置いているかは
[architecture.md](architecture.md#チューナー側-mirakc--エージェント)。

| ファイル | 役割 |
| --- | --- |
| `mirakc/agent.ts` | mirakc の起動と停止、denpa からの窓口 (HTTP) |
| `mirakc/scan.ts` | 物理チャンネルの総当たり |
| `mirakc/config.ts` | mirakc の `config.yml` の読み書き |
| `mirakc/config.yml` | 初回に配る設定の雛形 |

## テスト

| 場所 | 何 |
| --- | --- |
| `tests/e2e/` | Playwright。番号順に、予約 → 録画 → ルール → 引き継ぎ → 放送の延長。**ファイル単位で並ぶ**ので、長いものは割ってある |
| `tests/stack.ts` | ワーカーごとに denpa と偽 mirakc を1式立てる (これでファイル単位に並べられる) |
| `tests/fake/` | 偽mirakc・偽の通知先・偽ffmpeg |
| `src/**/*.test.ts` | 純粋関数の境界条件 (bun test) |
| `mirakc/*.test.ts` | チューナー側 (設定の読み書き、スキャン) |
| `windows/verify.ps1` `mac/verify.sh` | `denpa://` の登録役 |

回し方と方針は [development.md](development.md) に置いてある。
