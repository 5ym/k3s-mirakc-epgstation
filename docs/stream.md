# 放送波ストリーミングシステム 構成設計

最終更新: 2026-08-02

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
│ チューナー (Mirakurun / EDCB)                                    │
└────────────────────────────┬────────────────────────────────────┘
                             │ MPEG-TS
                    ┌────────┴────────┐
                    │      tee        │
                    └─┬──────┬──────┬─┘
                      │      │      │
        ┌─────────────┘      │      └─────────────┐
        ▼                    ▼                    ▼
┌───────────────┐   ┌────────────────┐   ┌──────────────────┐
│ tsreadex      │   │ B24 字幕抽出    │   │ psisiarc         │
│   ↓           │   │ (tsreadex の    │   │ PSI/SI +         │
│ ffmpeg /      │   │  ID3化 または   │   │ データカルーセル  │
│ QSVEncC 等    │   │  PES 直接抽出)  │   │                  │
│   ↓           │   │                 │   │                  │
│ AV1 + Opus    │   │ B24 PES + PTS   │   │ .psc ストリーム   │
│ fMP4 チャンク  │   │                 │   │                  │
└───────┬───────┘   └────────┬────────┘   └─────────┬────────┘
        │                    │                      │
        └────────────────────┼──────────────────────┘
                             ▼
              ┌──────────────────────────────┐
              │   SvelteKit サーバ            │
              │  ・プロセス管理／再起動        │
              │  ・WebSocket ハブ             │
              │  ・BML通信系プロキシ           │
              └──────────────┬───────────────┘
                             │ WebSocket (メディア + サイドチャネル)
                             ▼
              ┌──────────────────────────────┐
              │   ブラウザ (SvelteKit client) │
              │  ・MSE / mpegts.js  → 映像音声 │
              │  ・aribb24.js       → 字幕     │
              │  ・web-bml          → データ放送│
              └──────────────────────────────┘
```

### 設計上の中核

**メディアとメタデータは同じコンテナに載らない。** ARIB字幕（B24 PES）もデータ放送（DSM-CC カルーセル + PSI/SI）も、fMP4 / WebM には規格上入れられず、ffmpeg も GStreamer も扱えない。したがって:

> **サイドチャネル用の WebSocket を 1 本用意し、字幕とデータ放送を同じ経路に相乗りさせる。**

これは迂回路ではなく、本システムの主要な設計要素である。

---

## 3. コンポーネント選定

| 役割 | 採用 | ★ | 備考 |
| --- | --- | --- | --- |
| TS 整形 | xtne6f/tsreadex | 41 | デュアルモノ無劣化分離、PID固定、字幕のID3化 |
| エンコード | FFmpeg（将来 QSVEncC/NVEncC/VCEEncC） | — | CLI パイプラインで差し替え可能 |
| 字幕デコード/描画 | monyone/aribb24.js | 57 | `feedB24(payload, pts, dts)` |
| データ放送抽出 | xtne6f/psisiarc | 19 | PSI/SI + カルーセルを .psc に圧縮 |
| データ放送描画 | otya128/web-bml | 246 | BMLブラウザ。サイドカーとして起動 |
| 再生 (Phase 1) | xqq/mpegts.js | 2,262 | MPEG-TS 直接再生、`PES_PRIVATE_DATA_ARRIVED` |
| 再生 (Phase 3) | MSE 直接 / Vanilagy/mediabunny | 6,846 | AV1+Opus fMP4 |
| WebRTC 化（任意） | bluenviron/mediamtx | 19,690 | AV1 over WebRTC / WHEP |

★は 2026-08-02 時点。日本の放送関連ツールはスター数が2桁だが**代替が存在しない**ため、数値で評価しないこと。

---

## 4. 段階的実装計画

AV1 から入ると前例ゼロの難所を3つ同時に踏むことになる。以下の順で進める。

### Phase 1 — H.264 + MPEG-TS で全機能を通す

- `tsreadex → ffmpeg (libx264 -tune zerolatency) → MPEG-TS → WebSocket → mpegts.js`
- 字幕: `PES_PRIVATE_DATA_ARRIVED` → `aribb24.js`
- データ放送: psisiarc → web-bml
- **KonomiTV / web-bml と同一構成であり、前例が豊富**

この時点で機能要件はすべて満たされる。ここを完成させてから先へ進む。

### Phase 2 — 字幕・データ放送をサイドチャネルに分離

- Phase 1 では mpegts.js が字幕を TS 内から拾っているが、これを **独立した WebSocket メッセージ**に切り出す
- コンテナ非依存になり、Phase 3 で映像形式を変えても字幕・データ放送のコードが無傷で残る

### Phase 3 — AV1 + Opus / fMP4 へ移行

- エンコーダとコンテナのみ差し替え。クライアントは MSE 直接 or mediabunny
- サイドチャネルは Phase 2 のまま変更なし

### Phase 4（任意） — 低遅延の追い込み

- MediaMTX 経由で WebRTC/WHEP（0.2秒級）
- または Media over QUIC（kixelated/moq, 1,431★）

---

## 5. 実装詳細

### 5.1 エンコード（Phase 3 想定）

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

### 5.2 WebSocket プロトコル

単一接続で全チャネルを多重化する。

```
[1 byte: channel][8 bytes: PTS (90kHz, BE)][payload...]

channel:
  0x00  video init segment (ftyp + moov)
  0x01  video media  (moof + mdat)
  0x10  audio init segment
  0x11  audio media
  0x20  ARIB B24 caption PES
  0x30  PSI/SI + データカルーセル (.psc chunk)
  0x40  制御 (チャンネル切替、EPG更新通知 等)
```

- init セグメントは接続直後に必ず送る（再送用にサーバ側で保持）
- MSE はバイト列をそのまま `appendBuffer()` に投げられるため、映像音声のパースは不要

### 5.3 時刻同期

| 対象 | 方法 |
| --- | --- |
| 映像・音声 | fMP4 の timescale で自動的に整合 |
| 字幕 | B24 の PTS を `feedB24(payload, pts, dts)` に渡す |
| エンコード遅延補正 | aribb24.js の `FeederOption.offset.time` |
| データ放送 | カルーセルは時刻同期不要（PMT/TOT/EIT の更新に追従） |

### 5.4 データ放送の統合

web-bml は Node.js サーバ + ブラウザクライアント構成（既定ポート 23234）。
**サイドカーとして起動し、iframe で抱えるのが最も低コスト。**

セルフホスト前提なので、NVRAM は web-bml の既定実装（サーバローカル保存）をそのまま使用する。

### 5.5 双方向（通信系コンテンツ）プロキシ

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

### GStreamer — 不採用

当初は「tsdemux の private pad で B24 を映像と同一クロック上で取得でき、tee が不要になる」ことを理由に有力視した。**データ放送要件の追加によりこの論拠は失効**（psisiarc が独立プロセスで TS を読むため tee は必須）。

残る比較では ffmpeg が優位:

- web-bml 自体が ffmpeg 前提（`FFMPEG` 環境変数、既定形式 `h264-mpegts`）
- tsreadex / psisiarc / tsreplace / KonomiTV も同様の CLI パイプライン形
- QSVEncC / NVEncC / VCEEncC が使える（GStreamer からは不可）
- GStreamer は ARIB/ISDB の知識・前例ゼロ
- 放送波の不安定さ（解像度変化、ステレオ⇄デュアルモノ）は tsreadex が吸収済み
- AV1 over WebRTC は MediaMTX 経由で取得可能

### ffmpeg の WHIP muxer — 不採用

音声 Opus・映像 H.264 固定かつ experimental。AV1 が使えない。
WebRTC が必要な場合は MediaMTX を経由する。

### MPEG-TS への AV1 多重 — 保留

AOM 公式仕様（AOMediaCodec/av1-mpeg2-ts、stream_type 0x06 + format_identifier `AV01`）は存在するが、
FFmpeg は PR、VLC は MR、GStreamer は WIP 段階。ブラウザ側デマクサも存在しない。
実装が揃えば「字幕を PES private のまま素通しできる」最も綺麗な構成になるため、継続監視する。

### Media over QUIC — Phase 4 の候補

字幕・データ放送を第一級のトラックとして扱える唯一の選択肢だが、IETF ドラフト段階。

---

## 7. 既知のリスク・未解決事項

| 項目 | 内容 | 対応 |
| --- | --- | --- |
| Safari 非対応 | Opus in mp4 / AV1 が MSE で通らない | Phase 1 の H.264+AAC 構成を fallback として残す |
| AV1 エンコード負荷 | ソフトウェアでのリアルタイム処理は困難 | ハードウェアエンコーダ前提。非対応環境は H.264 に fallback |
| web-bml の実装範囲 | STD-B24 / TR-B14 / TR-B15 の部分実装。一部イベント・API 未実装 | 実際のチャンネルで動作確認。完全互換は期待しない |
| web-bml の通信機能 | 実装の有無・範囲を未確認 | ソース（`client/`, `documents/`）で要確認 |
| カルーセル初期表示 | 数秒周期の繰り返し送出のため初期表示に数秒かかる | 仕様上の制約。低遅延要件とは別軸として扱う |
| BML のレイアウト | 映像プレーンの座標系前提 | 字幕と共通のオーバーレイ層を作り、リサイズ追従を一元化 |
| 規約面 | 通信系サーバへの非受信機アクセス | 個人の視聴環境の範囲に留める |

---

## 8. 参考リポジトリ

| リポジトリ | ★ | 用途 |
| --- | --- | --- |
| bluenviron/mediamtx | 19,690 | WebRTC/WHEP 化（Phase 4） |
| video-dev/hls.js | 16,855 | HLS 経路を採る場合 |
| pion/webrtc | 16,682 | 自前 WebRTC を書く場合 |
| shaka-project/shaka-player | 8,187 | DASH 経路を採る場合 |
| Vanilagy/mediabunny | 6,846 | WebCodecs 移行時のデマクサ |
| Dash-Industry-Forum/dash.js | 5,539 | 同上 |
| xqq/mpegts.js | 2,262 | Phase 1 の再生 |
| kixelated/moq | 1,431 | Phase 4 の候補 |
| tsukumijima/KonomiTV | 1,007 | 参考実装 |
| otya128/web-bml | 246 | データ放送 |
| xqq/libaribcaption | 127 | ネイティブ側で字幕が要る場合 |
| monyone/aribb24.js | 57 | 字幕 |
| monyone/biim | 49 | LL-HLS 化する場合 |
| xtne6f/tsreadex | 41 | TS 整形 |
| xtne6f/psisiarc | 19 | データ放送抽出 |

★は 2026-08-02 時点の GitHub スター数。
