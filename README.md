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
| Windows | VLC + `denpa://` の登録 (下記) |
| Mac | VLC + `denpa://` の登録 (下記) |
| Android | 動画が再生できるアプリ (端末が選択画面を出します) |
| iOS / iPadOS | VLC |
| Kodi | `/dav` を WebDAV サーバーとして追加。Android TV・Fire TV でもこれで観られます |

### Windows

Windows にも Mac にも、Android の intent のような「どのアプリで開くか選ばせる」
仕組みがありません。VLC は自分のスキームも持たないので、`denpa://` を自前で用意します。

PowerShell を開いて、

```powershell
$s="$env:TEMP\denpa.ps1"; irm https://raw.githubusercontent.com/DAnything/denpa/main/windows/denpa.ps1 -OutFile $s; & $s
```

- 途中で **UAC の確認が出ます**。これは*毎回の「このサイトは PowerShell を開こうと
  しています」を消すため*だけに使います (ブラウザのポリシーは管理者でないと書けません)。
  断っても再生自体はできます
- **書いたあと、ブラウザを一度終了してから開き直してください。** 反映されません
- denpa を別の場所 (既定は `dp.home.arpa` と `dp.doany.io`) で開いているなら
  `-Origins http://denpa.example` のように渡してください

```powershell
& $s -Test      # 実際に開いてみる
& $s -Show      # 登録されている中身を見る
& $s -Remove    # 解除
```

VLC が見つからないときは `-PlayerPath "C:\...\vlc.exe"` で場所を渡します。

> 登録の中身は**レジストリの値そのもの**です。ファイルを置かないので、後から消えたり
> 移動したりして壊れません。登録先は HKCU なので、登録自体に管理者権限は要りません。
> 開くのは http(s) だけで、失敗したらメッセージボックスを出します
> (黙って終わると「押しても何も起きない」になるため)。

### Mac

```sh
curl -fsSL https://raw.githubusercontent.com/DAnything/denpa/main/mac/denpa.sh | sh
```

```sh
sh denpa.sh --test     # 実際に開いてみる
sh denpa.sh --show     # 登録されている中身を見る
sh denpa.sh --remove   # 解除
```

- **こちらは管理者権限が要りません。** ただし Windows と同じく、
  **ブラウザを一度終了してから開き直す**まで確認ダイアログは消えません。
  許す origin は `DENPA_ORIGINS` で変えられます (Safari にこれに当たる設定はありません)
- VLC は `/Applications/VLC.app/Contents/MacOS/VLC` を見ます。違うところに
  入れているなら `DENPA_VLC` で渡してください

> macOS でスキームを名乗れるのは**アプリケーションバンドルだけ**なので、受け口として
> 小さなアプレットを `~/Applications/denpa.app` に作ります。中身は「届いたリンクを
> denpa.sh に渡す」だけで、その denpa.sh は
> `~/Library/Application Support/denpa/` に控えられるので、落としてきたファイルを
> 消しても壊れません。組み立てに使う `osacompile` と `PlistBuddy` は最初から入っています。
> **実機での確認は取れていません** ([docs/development.md](docs/development.md#再生の受け口-windows--mac))。

**放送中のものをそのまま観たい**ときは、denpa ではなく mirakc に直接繋ぎます。
Kodi の PVR IPTV Simple Client に

- プレイリスト: `http://<mirakcのホスト>:40772/api/iptv/playlist`
- EPG: `http://<mirakcのホスト>:40772/api/iptv/xmltv`

を入れると、番組表付きのライブTVになります (Android TV・Fire TV も同じ)。
denpa は通らないので、予約もベーシック認証も効きません。
詳しくは [docs/architecture.md](docs/architecture.md#ライブ視聴)。

## もっと詳しく

- [docs/architecture.md](docs/architecture.md) — **なぜこの形なのか** (決めたこと・踏んだ落とし穴)
- [docs/app.md](docs/app.md) — **どこに何があるか** (ファイル・環境変数・画面・状態遷移)
- [docs/data.md](docs/data.md) — mirakc に都度聞くもの / denpa が持つもの
- [docs/development.md](docs/development.md) — **手を入れるとき** (開発環境・テスト)
- [docs/stream.md](docs/stream.md) — ライブ視聴の設計 (未実装)
