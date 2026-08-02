# Mac で再生する

Windows と同じ事情です。macOS にも「どのアプリで開くか選ばせる」仕組みは無く、
VLC は macOS 版に URL スキームを持ちません。`denpa://` を自前で用意して
[mac/denpa.sh](../mac/denpa.sh) で登録します。リンクの形は Windows 版と同じです。

```sh
sh denpa.sh            # 登録
sh denpa.sh --test     # 実際に開いてみる
sh denpa.sh --show     # 登録されている中身を見る
sh denpa.sh --remove   # 解除
```

- **配るのはこの1本だけ**です。macOS でスキームを名乗れるのは
  **アプリケーションバンドルだけ**なので、受け口として小さなアプレットを
  `~/Applications/denpa.app` に作りますが、中身は「届いたリンクを denpa.sh 自身に
  渡す」だけ。登録のときにスクリプトが自分自身を
  `~/Library/Application Support/denpa/` へ写すので、落としてきたファイルを
  消したり移したりしても壊れません。組み立てに使う `osacompile` と `PlistBuddy` は
  macOS に最初から入っているので、入れるものはありません
- 開くのは http(s) だけです。リンクは外から渡ってくるので `file://` などは食わせません。
  失敗したら `display alert` を出します(黙って終わると「押しても何も起きない」になる)
- **毎回出る確認ダイアログ**は Chrome と Edge のポリシー
  (`AutoLaunchProtocolsFromOrigins`) で黙らせます。macOS では管理者権限が要りません。
  **反映にはブラウザの再起動が要ります。** 許す origin は `DENPA_ORIGINS` で変えられます
  (Safari にこれに当たる設定はありません)
- VLC の場所は `/Applications/VLC.app/Contents/MacOS/VLC` を見ます。違うところに
  入れているなら `DENPA_VLC` で渡してください

リンクの復号と引数の渡し方は Mac でなくても確かめられます。

```sh
sh mac/verify.sh
```

> **実機での確認は取れていません。** 上の `verify.sh` が見ているのはリンクの処理までで、
> アプレットの組み立てと登録 (`osacompile` / `PlistBuddy` / `lsregister`) は
> macOS がないと走らせられません。
