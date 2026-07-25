# k3s epg

このディレクトリには EPG スタックの k3s マニフェストとローカルファイルが置かれています。

## チャンネルスキャン・局ロゴ

Mirakurun は録画・視聴で開いたチューナーセッションにもEPGパーサーを常時
アタッチしているため、通常の録画がそのままサービス/EPG情報の更新を兼ねます。
局ロゴもTR-B15のエンジニアリングサービスから自動抽出され、`server.yml`の
`logoDataInterval`(既定7日 = 604800000ms)で鮮度管理されます。mirakc時代の
ような専用スキャンスクリプトやCronJobは不要です。

`mirakurun/channels.yml` に登録済みのチャンネルは `serviceId` を明示していない
ため、Mirakurun が自動でサービスをスキャンして解決します。新しいチャンネルを
追加したい場合は `mirakurun/channels.yml` に `name`/`type`/`channel` を追記して
コミットしてください(CIがイメージを再ビルドし、`k3s/deployment.yaml` の
イメージタグを自動で更新します)。

現在のチューニング状況・登録サービス一覧はMirakurunのWeb UI
(`https://m.doany.io/`)から確認できます。

## 補足

- Mirakurunの設定は `mirakurun/server.yml`/`tuners.yml`/`channels.yml` の3
  ファイルで管理しています。これらは Docker イメージのビルド時に
  `/app-config.default/` へ焼き込まれ、`mirakurun-config` PVC (`/app-config`)
  が空の場合にのみ初回起動時の initContainer でコピーされます。2回目以降の
  起動では、Mirakurun が自動スキャンで書き込んだ `channels.yml` の更新分
  (自動解決されたサービスIDなど)がPVC側に残ります。
- `mirakurun-data` PVC (`/app-data`) には EPG データベースと収集済みの
  局ロゴが格納されます。
- ビルド元ファイルは `mirakurun/` 以下にあり、サーバー上で直接編集してください。
