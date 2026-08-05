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

**指しているのは `latest` で、これはリリースを作ったときだけ動きます。** main へ
入ったぶんは `develop` に積み上がるので、作業中のものが勝手に降ってくることは
ありません ([docs/architecture.md](docs/architecture.md#像のタグ))。

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

## 誰を通すか

**何も設定しなくても、掛かった状態で上がります。** 初回の起動で、ベーシック認証が
無ければ**その場で作ります**。以前は設定するまで録画も WebDAV も誰でも取れる状態で、
しかも掛け忘れに気付く手立てがありませんでした。

ユーザー名は **`denpa` で固定**。パスワードは24文字を自動で作り、**起動のログに
1度だけ**出します。

```text
[boot] ベーシック認証を作りました: denpa / abYHnrdeniq7npvdZNkakKQV
       設定画面から見直せます。プレイヤー (VLC / Kodi) にも同じものを入れてください
```

以降は**設定画面のベーシック認証の欄**にそのまま出ています (目のボタンで表示、隣でコピー)。
Kodi や VLC にも同じものを入れます。

### パスワードが分からなくなったら

**遠くのサーバに入れて、ログを流してしまったとき**です。画面を開くにもその
パスワードが要るので、DBから直に読みます (像に `bun` が入っているのでそれで足ります)。

```sh
# docker compose
docker compose -f compose.prod.yml exec denpa \
  bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.env.DENPA_DB ?? "/app/data/denpa.db", {readonly: true}); console.log(db.query("SELECT value FROM settings WHERE key = ?").get("basicAuthPassword")?.value)'

# Kubernetes
kubectl -n denpa exec deploy/denpa -- \
  bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.env.DENPA_DB ?? "/app/data/denpa.db", {readonly: true}); console.log(db.query("SELECT value FROM settings WHERE key = ?").get("basicAuthPassword")?.value)'
```

立てた直後なら、起動のログにも残っています
(`docker compose logs denpa | grep ベーシック認証` / `kubectl -n denpa logs deploy/denpa | grep ベーシック認証`)。
**作り直すのは最後の手段です** — 登録済みのプレイヤーが全部つながらなくなります。

### LAN からは何も聞かせない

家の中の端末に毎回パスワードを入れさせたくないときは、**通す網を書けます**。

```sh
TRUSTED_NETWORKS=10.10.0.0/16
ADDRESS_HEADER=x-forwarded-for   # 前段にリバースプロキシを置いているとき
```

ここから来た相手には**ベーシック認証も OIDC も掛かりません**。プレイヤー
(VLC / Kodi / Infuse) に資格情報を入れずに使わせるためのものです。CIDR の
カンマ区切りで、いくつでも並べられます。

> **`ADDRESS_HEADER` を忘れると誰も当たりません。** プロキシ越しだと、接続元として
> プロキシの住所が見えるためです。逆に、denpa へ直に届く経路が残っていると
> ヘッダを詐称できます — 前段を通してしか触れないことが前提です。

### 外から使うなら OIDC を

**ベーシック認証だけでインターネットに晒さないでください。** 資格情報が1つきりで、
誰が入ったのか分からず、切りたいときはパスワードごと替えるしかありません
(=登録済みのプレイヤーが全部つながらなくなります)。

3つ渡すと、画面のほうは **OIDC でのログイン**に替わります。

```sh
OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_GROUP=...   # このグループに居る人だけ通す (省くと入れた人は全員)
```

**ファイルを取りに来る口 (`/api/recordings/<id>/file` と `/dav`) はベーシック認証の
ままです。** VLC も Kodi も Infuse もログイン画面へのリダイレクトを扱えないためで、
だから「画面は OIDC・プレイヤーはベーシック認証」の2本立てになります。
入れ方は [docs/auth.md](docs/auth.md) に。

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
