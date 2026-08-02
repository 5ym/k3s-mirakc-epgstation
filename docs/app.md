# denpa (録画・エンコード管理アプリ)

mirakc から EPG と TS を受け取り、予約・録画・エンコード・保存先への配置までを行う。
出来上がった mkv は保存先に置かれ、denpa が配って外部プレイヤーで見る。見終わったものは
自動的に消える。EPGStation の置き換えとして作ったもので、エンコード設定はそこから移した。

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
| `src/lib/server/scramble.ts` | スクランブルの検出と、mirakc 側への解除依頼 |
| `src/lib/server/scan.ts` | チャンネルスキャン (mirakc に投げて進み具合を読む) |
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
| `START_MARGIN` / `END_MARGIN` | `10000` / `15000` | 録画の前後マージン(ms) |
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
| `DENPA_AUTOSTART` | `1` | `0` で常駐処理を止める |

## 画面

| 画面 | 役割 |
| --- | --- |
| `/` | **予約と録画**を2ペインで並べる。予約の取消/競合再計算、再生リンク・再エンコード・削除 |
| `/guide` | 番組表(グリッド)と番組検索、EPG取得、チャンネルスキャン。検索はルールと同じ条件で絞り込め、そのままルールにできる |
| `/rules` | 自動予約ルールの一覧と作成 |
| `/settings` | 録画のしかた(コーデック/CM)、通知先(Webhook)、ベーシック認証、EPGStation からの引き継ぎ |
| `/api/recordings/<id>/file` | 録画ファイル。Range 対応 |
| `/dav` | WebDAV (PROPFIND / GET / HEAD)。Kodi 用。書き込みは受けない |

## テスト

E2E を主、単体テストは純粋関数の境界条件だけ、という方針。

```sh
docker compose run --rm unit                # bun test
docker compose run --rm e2e                 # Playwright
docker compose run --rm unit bun run lint   # Biome + Prettier
docker compose run --rm unit bun run format # 整形を適用
```

E2E は偽mirakc・偽の通知先・偽ffmpeg を立てて、予約から録画・CM検出・エンコード・
保存先への配置・視聴済み削除までを実際に通す (`tests/fake/`)。偽mirakcは1番組10秒に
してあるので、録画完了まで待っても30秒で終わる。
