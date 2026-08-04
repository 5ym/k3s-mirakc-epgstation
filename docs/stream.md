# 放送波ストリーミングシステム 構成設計

最終更新: 2026-08-03

---

## 1. 前提

| 項目 | 内容 |
| --- | --- |
| デプロイ形態 | **セルフホスト（1ユーザー = 1サーバ）** |
| アプリ | SvelteKit 単一アプリ（配信・視聴の両方を担当） |
| 入力ソース | 放送波 MPEG-TS（ISDB-T / ISDB-S） |
| 目標コーデック | AV1 + Opus |
| 必須機能 | ARIB字幕、データ放送（双方向含む）、複数音声・映像ストリーム |
| 非機能要件 | 低遅延 |

セルフホスト前提であることから、以下は**設計上の考慮から外す**:

- NVRAM のマルチユーザー分離（受信機 = サーバ = ユーザーが 1:1:1 で対応するため）
- ユーザーごとの地域設定・リモコン設定の分離
- 通信系コンテンツのプロキシにおけるユーザー識別

---

## 2. 全体構成

```
┌─────────────────────────────────────────────────────────────────┐
│ チューナー (エージェント)                                     │
└────────────────────────────┬────────────────────────────────────┘
                             │ MPEG-TS
                    ┌────────┴────────┐
                    │      tee        │
                    └─┬──────┬──────┬─┘
                      │      │      │
        ┌─────────────┘      │      └─────────────┐
        ▼                    ▼                    ▼
┌───────────────┐   ┌────────────────┐   ┌──────────────────┐
│ tsreadex      │   │ ffmpeg          │   │ psisiarc         │
│   ↓           │   │ + libaribcaption│   │ PSI/SI +         │
│ ffmpeg /      │   │ (sub2video)     │   │ データカルーセル  │
│ QSVEncC 等    │   │   ↓             │   │                  │
│   ↓           │   │ 字幕の絵 (RGBA) │   │                  │
│ AV1 + Opus    │   │ + PTS           │   │ .psc ストリーム   │
│ fMP4 チャンク  │   │                 │   │                  │
└───────┬───────┘   └────────┬────────┘   └─────────┬────────┘
        │                    │                      │
        └────────────────────┼──────────────────────┘
                             ▼
              ┌──────────────────────────────┐
              │   SvelteKit サーバ            │
              │  ・プロセス管理／再起動        │
              │  ・字幕の切り抜き + PNG化      │
              │  ・WebSocket ハブ             │
              │  ・BML通信系プロキシ           │
              └──────────────┬───────────────┘
                             │ WebSocket (メディア + サイドチャネル)
                             ▼
              ┌──────────────────────────────┐
              │   ブラウザ (SvelteKit client) │
              │  ・MSE 直接        → 映像音声 │
              │  ・canvas 重ね     → 字幕     │
              │  ・web-bml         → データ放送│
              └──────────────────────────────┘
```

### 設計上の中核

**メディアとメタデータは同じコンテナに載らない。** ARIB字幕（B24 PES）もデータ放送（DSM-CC カルーセル + PSI/SI）も、fMP4 / WebM には規格上入れられず、ffmpeg も GStreamer も扱えない。したがって:

> **サイドチャネル用の WebSocket を 1 本用意し、字幕とデータ放送を同じ経路に相乗りさせる。**

これは迂回路ではなく、本システムの主要な設計要素である。

### 字幕はサーバで絵にする

**ブラウザに B24 を渡さない。** サーバ側で libaribcaption に描かせ、**絵と時刻だけ**を送る。

放送に絵は流れてこない。乗っているのは文字と「どこに・どの大きさで・何色で・背景の箱つきで」という指定で、テレビはそれを見て毎回自分で描いている。`-sub_type bitmap` はその描画を libaribcaption にやらせたもので、**それが「放送どおりの字幕の絵」**になる。

この経路は**録画側で実装・実測済み**（[architecture.md「字幕は PGS 1本だけ」](architecture.md)、`src/lib/server/subtitle.ts`）。live で変わるのは出口だけで、`.sup` に書く代わりに WebSocket へ流す。

| | サーバで描く（採用） | ブラウザで描く（aribb24.js） |
| --- | --- | --- |
| 外字 (DRCS) | そのまま絵になる | 実装依存 |
| 位置・背景の箱・点滅 | 放送どおり | 実装依存 |
| 録画との見た目 | **完全に同じ**（同じ描画系） | 別実装なので揃わない |
| 帯域 | 実測 **約 1 kB/s**（下記） | 数百バイト／字幕 |
| サーバ負荷 | live 1本につき ffmpeg が**もう1プロセス** | なし |
| クライアント側の自由度 | 拡大は画像の拡大になる | 文字サイズを変えられる |
| 持つコード | 出口だけ（録画と共通） | 字幕ライブラリ1本 |

帯域の実測値: 5分の番組で字幕は11枚、1枚あたり30KB前後。**約 1 kB/s** で、映像の隣では誤差になる。字幕は「次が来たら前を消す」動作なので、届いた瞬間に出して次で消せば遅延も増えない。

### 送るのは PGS ではなくパレット PNG

録画側は同じ絵を PGS にしている。live でもそのまま送りたくなるが、**ブラウザに PGS の
デコーダが無い**。自分で書くことになるうえ、PGS は色を YCrCb 限定レンジでしか持てないので、
サーバで変換したものをクライアントで戻す往復が入る。あの変換は mkv に入れるための
制約であって、live には無い。

代わりに**パレット PNG (color type 3)** で送る。作りは PGS とほとんど同じで、
持っている部品もそのまま使える。

| | PGS そのまま | **パレット PNG** | RGBA PNG |
| --- | --- | --- | --- |
| 使い回せるもの | `quantize` + `rle` + セグメント組み立て | **`quantize` + PLTE/tRNS の書き出し** | チャンクの書き出しだけ |
| 色 | 256色 + **YCrCb の往復** | 256色（PLTE に RGB のまま入る。往復なし） | 無劣化 |
| 大きさ | 1枚 30KB 前後 | 同程度（8bpp + deflate） | やや大きい |
| クライアント | **PGS デコーダを自作** | `createImageBitmap()` | `createImageBitmap()` |

`quantize` は `src/lib/pgs.ts`、PLTE/tRNS の組み立ては `src/lib/ts/logo-palette.ts`
（ARIB ロゴ用に書いたもの）。deflate は `node:zlib`。実測で字幕は230色なので、
256色に落としても実質劣化しない。

**要するに PGS からセグメントの殻を外して PNG に着替えるだけ**で、サーバ側の再利用度は
PGS を送るのと変わらず、クライアントに書くコードが無くなる。

---

## 3. コンポーネント選定

| 役割 | 採用 | ★ | 備考 |
| --- | --- | --- | --- |
| TS 整形 | xtne6f/tsreadex | 41 | デュアルモノ無劣化分離、PID固定 |
| エンコード | FFmpeg（将来 QSVEncC/NVEncC/VCEEncC） | — | CLI パイプラインで差し替え可能 |
| 字幕の描画 | xqq/libaribcaption | 127 | `-sub_type bitmap` + sub2video。録画側と同じ。denpa の ffmpeg は `--enable-libaribcaption` で組んである |
| データ放送抽出 | xtne6f/psisiarc | 19 | PSI/SI + カルーセルを .psc に圧縮 |
| データ放送描画 | otya128/web-bml | 246 | BMLブラウザ。サイドカーとして起動 |
| 再生 | MSE 直接 / Vanilagy/mediabunny | 6,846 | AV1+Opus fMP4 |
| WebRTC 化（任意） | bluenviron/mediamtx | 19,690 | AV1 over WebRTC / WHEP |

★は 2026-08-02 時点。日本の放送関連ツールはスター数が2桁だが**代替が存在しない**ため、数値で評価しないこと。

**mpegts.js と aribb24.js は使わない。** どちらも「H.264 + MPEG-TS をブラウザで直接再生し、
字幕も TS の中から拾う」構成のための部品で、fMP4 + サイドチャネルにすると出番が無くなる。
段階を踏むために一度その構成を通す案もあったが、**字幕の経路が録画側で先に完成した**ため、
捨てることになるコードを書く理由が無くなった。

---

## 4. 実装の順序

作るものは1つ。難所は「AV1 のリアルタイムエンコード」だけに絞れているので、そこだけ逃げ道を用意する。

1. **メディア経路** — `tsreadex → ffmpeg → fMP4 → WebSocket → MSE`。まず映像音声だけ出す
2. **字幕** — 2本目の ffmpeg を足してサイドチャネルへ流し、canvas に重ねる（録画側の実装を流用）
3. **データ放送** — psisiarc → web-bml をサイドカーとして起動し、iframe で抱える
4. **低遅延の追い込み（任意）** — MediaMTX 経由で WebRTC/WHEP（0.2秒級）、または Media over QUIC

**コーデックは段階ではなく設定にする。** AV1 が回らない環境・Safari では H.264 + AAC に
切り替える。エンコーダとコンテナ以外は共通なので、字幕もデータ放送もそのまま動く。

---

## 5. 実装詳細

### 5.1 エンコード

```bash
tsreadex -x 18/38/39 -n -1 -a 13 -b 5 -c 1 -u 1 - \
| ffmpeg -copyts -i - \
    -map 0:v:0 -c:v libsvtav1 -g 120 -preset 11 \
      -svtav1-params "pred-struct=1:lookahead=0" \
      -f mp4 -movflags +empty_moov+frag_every_frame+default_base_moof \
      -flush_packets 1 pipe:3 \
    -map 0:a:0 -c:a libopus -b:a 128k -application lowdelay -frame_duration 20 \
      -f mp4 -movflags +empty_moov+frag_every_frame+default_base_moof \
      -flush_packets 1 pipe:4
```

- `frag_every_frame` によりフレーム単位の moof/mdat が出力され、バッファ遅延がほぼ消える
- トラックごとに別 pipe へ出すのは、クライアントで SourceBuffer を分けるため
- 複数音声・複数映像は `-map` と pipe を増やす
- Node 側は `spawn(..., { stdio: ['pipe','pipe','pipe','pipe','pipe'] })`
- **`-copyts` 必須**（元TSの90kHz PTSを維持し、字幕・データ放送と同一時間軸に揃える）

AV1 のリアルタイムエンコードはソフトウェアでは厳しい。実運用では
`av1_nvenc`（RTX40以降）/ `av1_qsv`（Arc・Meteor Lake以降）/ `av1_amf`（RDNA3以降）を前提とする。

### 5.2 字幕（sub2video）

tee の2本目を、映像を作らない ffmpeg に食わせる。

```bash
ffmpeg -copyts -sub_type bitmap -canvas_size 1920x1080 \
    -font 'Rounded M+ 1m for ARIB,...' -i - \
    -filter_complex '[0:s:0]showinfo[v]' -map '[v]' \
    -fps_mode passthrough -f rawvideo -pix_fmt rgba pipe:1
```

- 字幕をフィルタの入力にすると、字幕1枚ごとに RGBA の映像フレームになる（sub2video）
- 時刻と大きさは `showinfo` が標準エラーに書く（`pts_time:` と `s:WxH`）。
  **`-copyts` を付けるので、この時刻は元TSの時間軸そのまま**になり、映像と揃う
- `-canvas_size` は必須。指定が無いと libaribcaption は 1440x1080 (PROFILE_A) とみなすので、
  1920x1080 の放送では字幕だけ横に伸びる
- フレームは画面まるごとの大きさで来る。**字幕のあるところだけ切り抜いて**送る
  （切り抜きは `src/lib/pgs.ts` の `crop` がそのまま使える）

サーバ側の処理は録画と同じで、切り抜いたあとに 256色へ落とし（`src/lib/pgs.ts` の
`quantize`）、パレット PNG を組んで（`src/lib/ts/logo-palette.ts` の PLTE/tRNS 書き出しと
`node:zlib` の deflate）サイドチャネルへ流す。ブラウザは `createImageBitmap()` で受けて
canvas に貼るだけでよい。**PGS のセグメントには包まない**（前掲の表）。

> **字幕が1枚も来ない番組がある。** 絵は描くものがあったときだけ出るので、本編に字幕が
> 無ければ0枚になる（録画側の実測でも同じ）。何も来ないことは異常ではない。

### 5.3 WebSocket プロトコル

単一接続で全チャネルを多重化する。

```
[1 byte: channel][8 bytes: PTS (90kHz, BE)][payload...]

channel:
  0x00  video init segment (ftyp + moov)
  0x01  video media  (moof + mdat)
  0x10  audio init segment
  0x11  audio media
  0x20  字幕の絵     [2:x][2:y][2:w][2:h][パレットPNG...]
  0x21  字幕を消す   (payload なし)
  0x30  PSI/SI + データカルーセル (.psc chunk)
  0x40  制御 (チャンネル切替、EPG更新通知 等)
```

- init セグメントは接続直後に必ず送る（再送用にサーバ側で保持）
- MSE はバイト列をそのまま `appendBuffer()` に投げられるため、映像音声のパースは不要
- 字幕の座標は `-canvas_size` の座標系。表示側の拡大率に合わせて canvas を伸ばす
- 途中から入ってきた視聴者のために、**いま出ている字幕はサーバが1枚だけ保持して再送する**

### 5.4 時刻同期

| 対象 | 方法 |
| --- | --- |
| 映像・音声 | fMP4 の timescale で自動的に整合 |
| 字幕 | `showinfo` の `pts_time`（`-copyts` により元TSの90kHz） |
| エンコード遅延補正 | サーバ側で字幕の PTS に一定量を足す（エンコーダの遅延ぶん） |
| データ放送 | カルーセルは時刻同期不要（PMT/TOT/EIT の更新に追従） |

字幕はエンコードを通らないぶん**映像より早く届く**。映像側の遅延は使うエンコーダで変わるので、
補正値は設定で持つ。

### 5.5 データ放送の統合

web-bml は Node.js サーバ + ブラウザクライアント構成（既定ポート 23234）。
**サイドカーとして起動し、iframe で抱えるのが最も低コスト。**

セルフホスト前提なので、NVRAM は web-bml の既定実装（サーバローカル保存）をそのまま使用する。

### 5.6 双方向（通信系コンテンツ）プロキシ

放送局の通信系サーバは受信機の専用ネットワークスタックを前提としており、CORS ヘッダを返さない。
そのため **SvelteKit サーバが中継する**。

```
/api/bml/proxy
  ├─ 許可ホストのホワイトリスト（PMT/AITから得た正規ドメインのみ）
  ├─ タイムアウト・レスポンスサイズ上限
  ├─ リクエストログ（デバッグ用）
  └─ 既定は無効。設定で明示的に有効化する
```

**既定オフとすること。** web-bml 系の実装も同じ方針を取っている
（TVTDataBroadcastingWV2: 「通信機能は既定では無効であり、その場合すべての外部へのリクエストはブロックされます」）。

#### 動作範囲の現実的な想定

| 種別 | 可否 |
| --- | --- |
| dボタン、ページ遷移、地域選択、クイズ選択肢 | ○ 受信機内で完結するため動作 |
| NVRAM への保存・読み出し | ○ web-bml に実装あり |
| 通信系コンテンツの取得（HTTP GET） | △ プロキシ経由なら技術的には可能 |
| 応募・投票などのデータ送信 | × 正規受信機以外からのアクセスは想定外。実装しない |

---

## 6. 技術選定の記録（採用しなかったもの）

### ブラウザ側での字幕デコード（aribb24.js）— 不採用

B24 をそのままブラウザへ送り、`feedB24(payload, pts, dts)` に食わせる構成。
クライアントで完結しプロセスも増えないが、**録画と live で描画系が二重になる**。
サーバで描けば見た目が完全に一致し、外字も背景の箱も放送どおりに出る。
帯域の増加は実測で約 1 kB/s と無視できる。

サーバ負荷（live 1本につき ffmpeg がもう1プロセス）が問題になる規模なら、
この構成へ戻す余地は残る。**サイドチャネルの形は変わらない**（B24 を 0x20 で流すだけ）。

### H.264 + MPEG-TS + mpegts.js で先に全機能を通す — 不採用

前例が豊富（KonomiTV / web-bml と同一構成）で、段階を踏む案として有力だった。
**字幕の経路が録画側で先に完成した**ため、あとで捨てるコードを書く理由が無くなった。
Safari や AV1 非対応環境のための H.264 fallback は、段階ではなく**コーデックの設定**として残す。

### GStreamer — 不採用

当初は「tsdemux の private pad で B24 を映像と同一クロック上で取得でき、tee が不要になる」ことを理由に有力視した。**データ放送要件の追加によりこの論拠は失効**（psisiarc が独立プロセスで TS を読むため tee は必須）。

残る比較では ffmpeg が優位:

- web-bml 自体が ffmpeg 前提（`FFMPEG` 環境変数、既定形式 `h264-mpegts`）
- tsreadex / psisiarc / tsreplace / KonomiTV も同様の CLI パイプライン形
- QSVEncC / NVEncC / VCEEncC が使える（GStreamer からは不可）
- GStreamer は ARIB/ISDB の知識・前例ゼロ
- 放送波の不安定さ（解像度変化、ステレオ⇄デュアルモノ）は tsreadex が吸収済み
- AV1 over WebRTC は MediaMTX 経由で取得可能
- **libaribcaption を組み込める**（`--enable-libaribcaption`。字幕の描画をそのまま使える）

### ffmpeg の WHIP muxer — 不採用

音声 Opus・映像 H.264 固定かつ experimental。AV1 が使えない。
WebRTC が必要な場合は MediaMTX を経由する。

### MPEG-TS への AV1 多重 — 保留

AOM 公式仕様（AOMediaCodec/av1-mpeg2-ts、stream_type 0x06 + format_identifier `AV01`）は存在するが、
FFmpeg は PR、VLC は MR、GStreamer は WIP 段階。ブラウザ側デマクサも存在しない。継続監視する。

### Media over QUIC — 低遅延化の候補

字幕・データ放送を第一級のトラックとして扱える唯一の選択肢だが、IETF ドラフト段階。

---

## 7. 既知のリスク・未解決事項

| 項目 | 内容 | 対応 |
| --- | --- | --- |
| AV1 エンコード負荷 | ソフトウェアでのリアルタイム処理は困難 | ハードウェアエンコーダ前提。非対応環境は H.264 に切り替え |
| Safari 非対応 | Opus in mp4 / AV1 が MSE で通らない | H.264 + AAC の設定に切り替え |
| 字幕用の2本目の ffmpeg | live 1本につきプロセスが1つ増える | 実測で負荷を確認。問題なら aribb24.js 構成へ戻す（§6） |
| 字幕の拡大 | 絵なので、拡大すると文字も引き伸ばされる | `-canvas_size` を表示解像度に合わせる |
| 字幕と映像のズレ | 字幕はエンコードを通らないぶん早く届く | 補正値を設定で持つ（§5.4） |
| web-bml の実装範囲 | STD-B24 / TR-B14 / TR-B15 の部分実装。一部イベント・API 未実装 | 実際のチャンネルで動作確認。完全互換は期待しない |
| web-bml の通信機能 | 実装の有無・範囲を未確認 | ソース（`client/`, `documents/`）で要確認 |
| カルーセル初期表示 | 数秒周期の繰り返し送出のため初期表示に数秒かかる | 仕様上の制約。低遅延要件とは別軸として扱う |
| BML のレイアウト | 映像プレーンの座標系前提 | 字幕と共通のオーバーレイ層を作り、リサイズ追従を一元化 |
| 規約面 | 通信系サーバへの非受信機アクセス | 個人の視聴環境の範囲に留める |

---

## 8. 参考リポジトリ

| リポジトリ | ★ | 用途 |
| --- | --- | --- |
| bluenviron/mediamtx | 19,690 | WebRTC/WHEP 化（低遅延化） |
| video-dev/hls.js | 16,855 | HLS 経路を採る場合 |
| pion/webrtc | 16,682 | 自前 WebRTC を書く場合 |
| shaka-project/shaka-player | 8,187 | DASH 経路を採る場合 |
| Vanilagy/mediabunny | 6,846 | WebCodecs 移行時のデマクサ |
| Dash-Industry-Forum/dash.js | 5,539 | 同上 |
| kixelated/moq | 1,431 | 低遅延化の候補 |
| tsukumijima/KonomiTV | 1,007 | 参考実装 |
| otya128/web-bml | 246 | データ放送 |
| xqq/libaribcaption | 127 | **字幕の描画**（denpa の ffmpeg に組み込み済み） |
| monyone/biim | 49 | LL-HLS 化する場合 |
| xtne6f/tsreadex | 41 | TS 整形 |
| xtne6f/psisiarc | 19 | データ放送抽出 |
| monyone/aribb24.js | 57 | ブラウザ側で字幕を描く場合（§6） |
| xqq/mpegts.js | 2,262 | MPEG-TS を直接再生する場合（不採用） |

★は 2026-08-02 時点の GitHub スター数。
