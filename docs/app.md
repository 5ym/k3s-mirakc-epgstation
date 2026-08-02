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
| `src/lib/server/epg.ts` | 番組表の取り込みと予約時刻の追従 |
| `src/lib/server/rules.ts` | ルール(キーワード/チャンネル/ジャンル)から予約を作る |
| `src/lib/server/reservations.ts` | 手動予約と取り消し |
| `src/lib/server/conflict.ts` | チューナー割り当てと競合判定 (純粋関数) |
| `src/lib/server/scheduler.ts` | 予約 → 録画の状態遷移 |
| `src/lib/server/recorder.ts` | TS の受信とファイル書き出し |
| `src/lib/server/cm.ts` | CM検出 (無音 + CM尺) |
| `src/lib/server/cm-jls.ts` | CM検出 (join_logo_scp。任意) |
| `src/lib/server/encoder.ts` | 録画のエンコード (AV1 / H.264) |
| `src/lib/play.ts` | 外部プレイヤーを開くURLの組み立て |
| `src/lib/server/library.ts` | 保存先でのファイル配置 |
| `src/lib/server/metadata.ts` | .nfo とサムネイル (Kodi など向け) |
| `src/lib/server/files.ts` | 録画の削除と、実体とDBの突き合わせ |
| `src/lib/server/serve.ts` | ファイルの配信 (Range 対応) |
| `src/lib/server/scramble.ts` | スクランブルの検出と、チューナー側への解除依頼 |
| `src/lib/server/scan.ts` | チャンネルスキャン (チューナー側に投げて進み具合を読む) |
| `src/lib/server/logo.ts` | 局ロゴの収集と保存 |
| `src/lib/ts/psi.ts` | TS の PSI (NIT / SDT) を読む。チューナー側と共通 |
| `src/lib/ts/logo.ts` | TS から局ロゴ (CDT) を読む |
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
| `scripts/repair.ts` | 引き継ぎで崩れたデータを直す道具 (使い捨て) |

## 状態遷移

```
予約 scheduled ─(開始時刻)→ recording ─→ done
      ├(チューナー不足)→ conflict
      └(始まらないまま放送終了)→ missed

録画 recording ─→ recorded ─(エンコード)→ encoding ─→ available ─(削除)→ 削除済み
```

チューナーの本数を数えるときは、番組の時刻ではなく前後マージンを足した
「実際に掴んでいる区間」で重なりを見ます。22:00 終了と 22:00 開始は実際には重なるので、
ここを揃えないと予約表では通っているのに実行時に録り逃します。

録画中にプロセスが落ちた場合、次の起動でまだ放送中なら録り直します。生TSは追記で
開くので、落ちるまでに録れていた分は残ります。放送が終わっていれば失敗に倒します。

DBは SQLite 1ファイル (`DENPA_DB`)。スキーマは `src/lib/server/schema.ts`。

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `MIRAKC_URL` | `http://mirakc:40772` | mirakc |
| `TUNER_AGENT_URL` | `http://mirakc:40773` | チューナー側のエージェント (スキャン・カード・解除) |
| `DENPA_DATA_DIR` | DBの隣 | 局ロゴの置き場 |
| `LOGO_SWEEP_INTERVAL` | `1800000` | ロゴを持っていない局を取りに行く間隔(ms) |
| `RECONCILE_INTERVAL` | `300000` | 保存先の実体とDBを突き合わせる間隔(ms) |
| `WRITE_NFO` | `1` | `.nfo` を書くか (Kodi など向け) |
| `THUMBNAIL_POSITION` / `THUMBNAIL_WIDTH` | `120` / `480` | サムネイルの切り出し位置(秒)と幅 |
| `DENPA_DB` | `/app/data/denpa.db` | SQLite の置き場 |
| `RECORDED_DIR` | `/app/recorded` | 生TSの作業領域 |
| `LIBRARY_DIR` | `/library` | エンコード済みの置き場。ここから配る |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | (空) | 両方入っているときだけベーシック認証が有効 |
| `BASIC_AUTH_SCOPE` | `files` | `files` … 配信と WebDAV だけ / `all` … 画面も含めて全部 |
| `FFMPEG` / `FFPROBE` | `/usr/local/bin/...` | 開発時は偽物に差し替える |
| `ENCODE_CONCURRENCY` | `1` | 録画エンコードの同時実行数。ライブ配信の本数とは無関係 |
| `ENCODE_CODEC` | `av1` | 録画の既定コーデック (`av1` / `h264`) |
| `ENCODE_H264_PRESET` / `ENCODE_H264_CRF` | `medium` / `22` | H.264 のときの品質 |
| `ENCODE_RETRY_SEEK` | `0.2` | 頭が壊れていて失敗したとき、捨てて再試行する秒数 |
| `START_MARGIN` / `END_MARGIN` | `10000` / `15000` | 録画の前後マージン(ms)。放送に追従しているときは mirakc 側が切れ目を決める |
| `FOLLOW_ONAIR` | `1` | 放送の延長に追従する。`0` で番組表の時刻どおりに開いて閉じる |
| `ONAIR_POLL_INTERVAL` | `30000` | 追従中に終了時刻を見に行く間隔(ms) |
| `ONAIR_FALLBACK_WAIT` | `90000` | 番組単位で開いても何も来ないとき、サービス単位に落とすまで(ms) |
| `EPG_SYNC_INTERVAL` | `600000` | EPG取得の間隔(ms) |
| `SCHEDULER_TICK` | `5000` | 予約チェックの間隔(ms) |
| `CM_CUT_DEFAULT` | `chapter` | `off` / `chapter` / `cut` の**初期値**。設定画面で変えられる |
| `CM_DETECTOR` | `silence` | `silence` / `jls` |
| `CM_SILENCE_NOISE` | `-50dB` | 無音とみなす音量 |
| `CM_SILENCE_DURATION` | `0.4` | 無音とみなす最短の長さ(秒) |
| `CM_TOLERANCE` | `0.6` | 「15秒の倍数」判定の許容誤差(秒) |
| `CM_MIN_BLOCK` | `30` | CMブロックとして採用する最短の長さ(秒) |
| `CM_JLS_COMMAND` | `/opt/jls/JoinLogoScpTrial.sh {input}` | jls検出器の起動コマンド |
| `CM_JLS_OUTPUT_DIR` | (空) | jls が avs を吐く場所。空なら入力と同じ場所と標準出力から探す |
| `CM_JLS_FALLBACK_FPS` | `29.97` | fps を取れなかったときに使う値 |
| `CM_DETECT_TIMEOUT` | `1800000` | CM検出を打ち切るまで(ms) |
| `PROGRAM_RETENTION` | `86400000` | 終わった番組をDBに残す期間(ms) |
| `HISTORY_RETENTION` | `1209600000` | 終わった予約と削除済み録画の行を残す期間(ms。既定は2週間) |
| `DENPA_AUTOSTART` | `1` | `0` で常駐処理を止める |

## 画面

| 画面 | 役割 |
| --- | --- |
| `/` | **予約と録画**を2ペインで並べる。予約の取消/競合再計算、再生リンク・再エンコード・削除。エンコード中のものは録画一覧の行に進み具合が出る |
| `/guide` | 番組表(グリッド)と番組検索、EPG取得。検索はルールと同じ条件で絞り込め、そのままルールにできる |
| `/rules` | 自動予約ルールの一覧と作成 |
| `/tuners` | チャンネルスキャン、チューナーの空き、取れているチャンネル (mirakc 側の局と番組表の集まり具合つき)、mirakc とカードリーダーの状態 |
| `/settings` | 録画のしかた(コーデック/CM)、通知先(Webhook)、ベーシック認証、EPGStation からの引き継ぎ |
| `/api/recordings/<id>/file` | 録画ファイル。Range 対応 |
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

## 引き継ぎで崩れたデータを直す

移行のロジック自体は直してあるので、これから引き継ぐ人には要らない。
**既に引き継いでしまった環境を直すためだけ**の使い捨て (`scripts/repair.ts`)。

```sh
# 何をするかを出すだけ
kubectl -n epg exec deploy/denpa -- bun scripts/repair.ts
# 実際に直す
kubectl -n epg exec deploy/denpa -- bun scripts/repair.ts --apply

# docker compose なら
docker compose -f compose.prod.yml exec denpa bun scripts/repair.ts --apply
```

直すのは2つ。

- **ルールのジャンル指定** — `{genre, subGenre}` のまま入っているものを `"7-0"` に直し、
  引けない値は落とす
- **保存先に入ってしまった生TS** — 作業領域へ移して `ts_path` に付け替える。
  `.nfo` とサムネイルも片付け、空になったフォルダは畳む

何度実行しても同じ結果になる。

## テスト

| 場所 | 何 |
| --- | --- |
| `tests/e2e/` | Playwright。番号順に、予約 → 録画 → ルール → 引き継ぎ → 放送の延長 |
| `tests/fake/` | 偽mirakc・偽の通知先・偽ffmpeg |
| `src/**/*.test.ts` | 純粋関数の境界条件 (bun test) |
| `mirakc/*.test.ts` | チューナー側 (設定の読み書き、スキャン) |
| `windows/verify.ps1` `mac/verify.sh` | `denpa://` の登録役 |

回し方と方針は [development.md](development.md) に置いてある。
