# denpa

テレビを録って観るためのもの。**mirakc(チューナー制御) + denpa(予約・録画・エンコード・配信)**
の2つだけで、メディアサーバは置きません。

```text
チューナー ── mirakc ── denpa ── 録画(mkv) ─┬─→ VLC / Infuse (URLスキーム)
                                              └─→ Kodi (WebDAV)
```

## 用意するもの

- **チューナー** — recisdb が扱えるもの (chardev / DVB)。ドライバはホスト側に入れておく
- **B-CASカード** と PC/SC 対応のリーダー
- **Docker** か **Kubernetes**

イメージは公開してあるので、**リポジトリを持ってくる必要はありません。**

## docker compose で動かす

```sh
mkdir denpa && cd denpa
curl -LO https://raw.githubusercontent.com/danything/denpa/main/compose.prod.yml
docker compose -f compose.prod.yml up -d
```

初回起動で `./config/config.yml` が出てきます。**そこの `tuners:` と、
`compose.prod.yml` の `devices:` を手元の機材に合わせて**から、

```sh
docker compose -f compose.prod.yml restart mirakc
```

チャンネルは書かなくて構いません(この後のスキャンで入ります)。

## Kubernetes で動かす

```sh
curl -L https://github.com/danything/denpa/archive/refs/heads/main.tar.gz | tar xz --strip=1 denpa-main/k3s
kubectl apply -f k3s/
```

`k3s/` は自分のクラスタ向けの例です。そのまま使えるものではないので、
**namespace・StorageClass・Ingress のホスト名**を書き換えてから適用してください。
必要なものは [docs/architecture.md](docs/architecture.md#クラスタ側の前提条件)。

## 最初にすること

1. **チャンネルスキャン** — 画面の「チューナー」から実行します。チャンネル設定は
   空で出荷しているので、これをやるまで番組表は空です。地上波の総当たりで
   十数分かかります
2. **EPGを取得** — スキャンが終わると自動で取り直します。番組表に出ればできています
3. **番組を予約** — 番組表から選ぶか、「ルール」でキーワードを登録して自動予約に

うまくいかないときは画面の「チューナー」を見てください。mirakc とカードリーダーの
状態、スキャンの1チャンネルごとの結果が出ます。**カードリーダーが NG のまま録ると、
成功したように見えて中身が全部スクランブルされたまま**になります。

## 再生

録画一覧のボタンから端末のプレイヤーを起動します。

| 端末 | 必要なもの |
| --- | --- |
| Windows | VLC。[docs/windows.md](docs/windows.md) で `denpa://` を登録 |
| Mac | VLC。[docs/mac.md](docs/mac.md) で `denpa://` を登録 |
| Android | 動画が再生できるアプリ (端末が選択画面を出します) |
| iOS / iPadOS | VLC |
| Kodi | `/dav` を WebDAV サーバーとして追加。Android TV・Fire TV でもこれで観られます |

## 開発

**ホストに bun は入れません。全部コンテナの中で動かします。**

```sh
docker compose up                           # 開発サーバ(:5173) + 偽mirakc(:40772)
docker compose run --rm unit                # 単体テスト
docker compose run --rm e2e                 # E2E (Playwright)
docker compose run --rm unit bun run lint   # リント + フォーマット確認
docker compose run --rm unit bun run format # フォーマット適用
```

実チューナーも ffmpeg も要りません。偽mirakc が番組表も録画ストリームも返し、
ffmpeg も既定では偽物 (`tests/fake/ffmpeg.sh`) を使います。

依存を足したら `docker compose run --rm unit bun install` を一度回してください
(`node_modules` は名前付きボリュームなので、イメージの焼き直しは不要です)。

## もっと詳しく

- [docs/architecture.md](docs/architecture.md) — 構成と、なぜそうしたか
- [docs/app.md](docs/app.md) — denpa の中身 (状態遷移・環境変数・テスト)
- [docs/data.md](docs/data.md) — mirakc に都度聞くもの / denpa が持つもの
- [docs/windows.md](docs/windows.md) — Windows で再生する準備
- [docs/mac.md](docs/mac.md) — Mac で再生する準備
- [docs/stream.md](docs/stream.md) — ライブ視聴の設計 (未実装)
