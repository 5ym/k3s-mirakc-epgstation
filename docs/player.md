# 再生の受け口 (`denpa://`)

Windows にも Mac にも、Android の intent のような「どのアプリで開くか選ばせる」
仕組みがありません。VLC は自分のスキームも持たないので、`denpa://` を自前で用意します。

リンクの形は両者で同じで、受け口だけが違います。

```text
denpa://play/<base64url のURL>/?title=<base64url の番組名>
```

## Windows

PowerShell を開いて、

```powershell
$s="$env:TEMP\denpa.ps1"; irm https://raw.githubusercontent.com/DAnything/denpa/main/windows/denpa.ps1 -OutFile $s; & $s
```

**管理者権限は要りません。** 登録先は自分のユーザーの下だけです。

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

## Mac

```sh
curl -fsSL https://raw.githubusercontent.com/DAnything/denpa/main/mac/denpa.sh | sh
```

```sh
sh denpa.sh --test     # 実際に開いてみる
sh denpa.sh --show     # 登録されている中身を見る
sh denpa.sh --remove   # 解除
```

- VLC は `/Applications/VLC.app/Contents/MacOS/VLC` を見ます。違うところに
  入れているなら `DENPA_VLC` で渡してください

> macOS でスキームを名乗れるのは**アプリケーションバンドルだけ**なので、受け口として
> 小さなアプレットを `~/Applications/denpa.app` に作ります。中身は「届いたリンクを
> denpa.sh に渡す」だけで、その denpa.sh は
> `~/Library/Application Support/denpa/` に控えられるので、落としてきたファイルを
> 消しても壊れません。組み立てに使う `osacompile` と `PlistBuddy` は最初から入っています。
> **実機での確認は取れていません** ([development.md](development.md#再生の受け口-windows--mac))。

## 「常に許可」が出ないとき

初めて再生ボタンを押すと、ブラウザが「このサイトは denpa を開こうとしています」と
聞いてきます。そこで **「常に許可」にチェックを入れて**開けば以後は出ません。

**チェックボックスが出ないときは、denpa を平文 (http) で開いています。**
Chrome も Edge も、この覚えさせ方を **https のページからしか許しません**
([ポリシーの説明](https://chromeenterprise.google/policies/external-protocol-dialog-show-always-open-checkbox/))。

`.arpa` のような内側だけの名前は ACME で証明書を取れませんが、**持っているドメインの
名前を LAN 内のアドレスに向ければ**、公開しないまま本物の証明書が使えます
(DNS-01 なので外から繋がる必要がありません)。

`k3s/ingress.yaml` にその名前を足してあり、**https://dp.l.doany.io** です。
Traefik 側で LAN 内 (10.10.0.0/16) からだけ通し、denpa 側もその網からは
何も聞きません (`TRUSTED_NETWORKS`、[auth.md](auth.md))。
プレイヤーが録画を取りに来るのも同じ口です。

## ライブ視聴

**放送中のものをそのまま観るのは、いまはできません。** mirakc をやめたときに、
その口 (下記) ごと無くなりました。denpa 側に作る話は
[stream.md](stream.md) にあります。

以前は Kodi の PVR IPTV Simple Client に mirakc の口
(`/api/iptv/playlist` と `/api/iptv/xmltv`) を入れれば、番組表付きの
ライブTVになっていました。denpa を通らないので、予約もベーシック認証も
効きませんでした。設計の話は [architecture.md](architecture.md#ライブ視聴)。
