# Windows で再生する

Windows だけは Android の intent のような仕組みが無く、プレイヤーごとのスキームを直に
叩くしかありません。VLC は Windows 版にスキームを持たないので、`denpa://` を自前で
用意して [windows/denpa.ps1](../windows/denpa.ps1) で登録します。

Windows だけは Android の intent のような仕組みが無く、プレイヤーごとのスキームを直に
叩くしかありません。VLC は Windows 版にスキームを持たないので、`denpa://` を自前で
用意して [windows/denpa.ps1](../windows/denpa.ps1) で登録します。

```powershell
.\denpa.ps1              # 登録 (VLC。-Player mpv で mpv)
.\denpa.ps1 -Test        # 実際に開いてみる
.\denpa.ps1 -Show        # 登録されている中身を見る
.\denpa.ps1 -Remove      # 解除
```

- `%1` で渡るリンクを**復号してプレイヤーに渡す一枚**は要りますが、それはレジストリの値に
  直接書きます。ファイルを置かないので、後から消えたり移動したりして壊れません。
  登録先は HKCU なので管理者権限も不要
- 開くのは http(s) だけです。リンクは外から渡ってくるので `file://` などは食わせません。
  失敗したらメッセージボックスを出します(黙って終わると「押しても何も起きない」になる)
- **毎回出る確認ダイアログ**を黙らせる方法はブラウザのポリシー
  (`AutoLaunchProtocolsFromOrigins`) しかありません。`HKCU\Software\Policies` は
  普通のユーザーには書けない(ACL で守られている)ので、**これだけは管理者として実行した
  ときに書きます**。飛ばしても再生自体はできます。**反映にはブラウザの再起動が要ります。**
  許す origin は `-Origins` で変えられます
- **再生速度を覚えさせたい**なら `-Player mpv` です。mpv は終了時の状態を URL ごとに
  残せるので、`save-position-on-quit=yes` (スクリプトが `mpv.conf` に足します) だけで
  速度も位置も録画ごとに残ります。VLC に同等の設定はありません(位置の再開のみ)
- レジストリに書く一行は壊れていても Windows が黙って何もしないだけなので、
  `windows/verify.ps1` で先に確かめられます。Windows でなくても走ります

```sh
docker run --rm -v "$PWD/windows:/w:ro" mcr.microsoft.com/powershell:latest \
    pwsh -NoProfile -File /w/verify.ps1
```

> `.ps1` は **UTF-8 BOM 付き + CRLF** で置いてあります。PowerShell 5.1 は BOM が無いと
> ANSI (日本語環境では CP932) として読み、CP932 の先行バイトが次の ASCII 文字を
> 巻き込むので `'` や `}` が消えて構文エラーになります。`.gitattributes` で保っています。
> WSL のパスから直接実行すると「セキュリティの警告」が出ます。
