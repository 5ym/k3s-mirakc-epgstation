# denpa

テレビを録って観るためのもの。**チューナーエージェント(選局)** と
**denpa(番組表・予約・録画・エンコード・配信)** の2つだけで、メディアサーバは置きません。

```text
チューナー ── エージェント ── denpa ── 録画(mkv) ─┬─→ VLC / Infuse (URLスキーム)
                                                    └─→ Kodi (WebDAV)
```

エージェントは**チャンネルを掴んで素のTSを流すだけ**です。番組表を読むのも、
局を選り分けるのも、CMを見つけるのも denpa がやります。

## 用意するもの

- **チューナー** — Linux DVB (PT2/PT3、PX-S1UD など)。ドライバはホスト側に入れておく
- **B-CASカード** と PC/SC 対応のリーダー
- **Docker** か **Kubernetes**

イメージは公開してあるので、**リポジトリを持ってくる必要はありません。**

## docker compose で動かす

```sh
mkdir denpa && cd denpa
curl -LO https://raw.githubusercontent.com/danything/denpa/main/compose.prod.yml
docker compose -f compose.prod.yml up -d
```

手元に合わせるのは `compose.prod.yml` の `devices:` だけです。**チューナーは
書かなくても動きます** — 定義が無ければエージェントが `/dev/dvb/*` を開いて、
地上波か衛星かまで自分で判別します。LNB や「1本だけ止める」を決めたいときは
画面の「チューナー」から書き換えます (`./config/tuners.json`)。

チャンネルも書きません。**スキャンで見つかったものは別のファイル**
(`channels.json`) に書き出されるので、機材の定義が巻き添えで消えることはありません。

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
2. **番組表を集める** — スキャンが終わると自動で集めに行きます。空いている
   チューナーの数だけ並べて回るので、待つのは数分です
3. **番組を予約** — 番組表から選ぶか、「ルール」でキーワードを登録して自動予約に

うまくいかないときは画面の「チューナー」を見てください。エージェントとカードリーダーの
状態、スキャンの1チャンネルごとの結果、番組表がどこまで集まったかが出ます。**カードリーダーが NG のまま録ると、
成功したように見えて中身が全部スクランブルされたまま**になります。

## 再生

**録画一覧の行を押すと**端末のプレイヤーが起動します。ブラウザは MPEG-2 も
AV1+Opus の mkv も素直には再生できないためです。番組の中身を読みたいときは
行の中の「詳細」から。

| 端末 | 必要なもの |
| --- | --- |
| Windows / Mac | VLC と `denpa://` の登録 ([docs/player.md](docs/player.md)) |
| Android | 動画が再生できるアプリ (端末が選択画面を出します) |
| iOS / iPadOS | VLC |
| Kodi | `/dav` を WebDAV サーバーとして追加。Android TV・Fire TV も同じ |

初回だけブラウザが「denpa を開こうとしています」と聞いてきます。
**「常に許可」にチェック**を入れれば以後は出ません。
**チェックが出ないときは平文 (http) で開いています** — Chrome も Edge も、
この覚えさせ方を https のページからしか許しません
([docs/player.md](docs/player.md#常に許可が出ないとき))。

**CM はチャプターとして入っています。** VLC なら `Shift`+`N` で次の章、
`Shift`+`P` で前の章へ飛べます (Windows・Mac 共通。`N` / `P` だけだと
プレイリストの前後になります)。Kodi と Infuse は再生中のメニューから章を選べます。

### ベーシック認証

Kodi や VLC に登録するときの**ユーザー名は `denpa` で固定**、パスワードは
**設定画面のベーシック認証の欄にそのまま出ています**。目のボタンで表示、隣でコピー。

ベーシック認証は `ユーザー名:パスワード` を一組で送る決まりなので、パスワードだけ
にはできません。思い出せないからと作り直すと登録済みの端末が全部つながらなくなるので、
まず設定画面を見てください。新しく決めるなら「作り直して保存」を押せば、
URLに埋めても壊れない文字だけで24文字作って、そのまま保存します。

## もっと詳しく

- [docs/architecture.md](docs/architecture.md) — **なぜこの形なのか** (決めたこと・踏んだ落とし穴)
- [docs/app.md](docs/app.md) — **どこに何があるか** (ファイル・環境変数・画面・状態遷移)
- [docs/data.md](docs/data.md) — エージェントに都度聞くもの / denpa が持つもの
- [docs/development.md](docs/development.md) — **手を入れるとき** (開発環境・テスト)
- [docs/player.md](docs/player.md) — `denpa://` の登録、ライブ視聴の繋ぎ方
- [docs/agent.md](docs/agent.md) — チューナーを掴むところ (エージェント・取り合い・B-CAS)
- [docs/encode.md](docs/encode.md) — CM とエンコード (字幕・AV1・CM検出)
- [docs/auth.md](docs/auth.md) — **誰を通すか** (OIDC でのログイン・ベーシック認証)
- [docs/migrate.md](docs/migrate.md) — **EPGStation からの引き継ぎ**
- [docs/roadmap.md](docs/roadmap.md) — これから入れるもの
- [docs/stream.md](docs/stream.md) — ライブ視聴の設計 (未実装)
