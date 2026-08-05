# 誰を通すか

**口によって守り方が違います。** 画面は人が見るもので、録画のファイルは
プレイヤーが取りに来るもの。同じ守り方はできません。

| 探しもの | 見る場所 |
| --- | --- |
| 全体像 | [architecture.md](architecture.md) |
| 環境変数の一覧 | [app.md](app.md) |
| 外部プレイヤーの設定 | [player.md](player.md) |

| 口 | 守り方 |
| --- | --- |
| `/api/recordings/<id>/file` と `/dav` | **ベーシック認証だけ** |
| それ以外 (画面と API) | **OIDC** (設定してあれば)。無ければベーシック認証 |
| `/login` `/login/callback` `/login/out` `/logout` | 素通し |

**プレイヤーはリダイレクトを扱えません。** VLC も Kodi も Infuse も、ログイン画面へ
飛ばされたところで何もできず「再生できません」で終わります。だからファイルを取りに
来る口だけは、前段に何を置いていようと素のベーシック認証のまま残してあります。

**OIDC を入れると、画面のぶんはベーシック認証から OIDC に移ります。**
`BASIC_AUTH_SCOPE=all` を入れたままでもそうします — 両方掛けると、ブラウザの
認証ダイアログを閉じないとログイン画面にすら行けないためです。

## OIDC でのログイン

**3つ揃ったときだけ有効**になります。揃っていなければ今までどおり、画面の前段に
置いた forward-auth 頼みのまま動きます。

| 変数 | |
| --- | --- |
| `OIDC_ISSUER` | 例 `https://login.microsoftonline.com/<tenant>/v2.0` |
| `OIDC_CLIENT_ID` | アプリ登録のアプリケーションID |
| `OIDC_CLIENT_SECRET` | クライアントシークレット |
| `OIDC_GROUP` | **このグループに居る人だけ通す。** 空なら入れた人は全員 |
| `OIDC_BYPASS_CIDR` | ここから来た人はログインを求めない (例 `10.10.0.0/16`) |
| `OIDC_SESSION_TTL` | ログインの有効期間(ms)。既定30日 |

**秘密を含むので環境変数だけから読み、設定画面には出しません。**

> **`PROTOCOL_HEADER=x-forwarded-proto` が要ります。** 戻ってくる口の住所も、控えの
> Cookie に `Secure` を付けるかどうかも、**リクエストの scheme から決めています**。
> adapter-node は `PROTOCOL_HEADER` も `ORIGIN` も無いと **https と決め打ち**するので、
> 平文で立てると「`https://.../login/callback` を Entra に送って弾かれる」
> 「http なのに `Secure` を付けてブラウザが Cookie を捨てる」のどちらかになります
> (偽の IdP を立てて確認済み)。k3s の manifest には元から入っています。

### ライブラリを入れていません

使う口は discovery・authorize・token・jwks の4つだけで、どれも素の HTTP と
WebCrypto で足ります。認証まわりで「中で何をしているか分からない」を抱えるより、
200行書くほうを選びました (`src/lib/server/oidc.ts`)。

使っているのは OIDC の標準だけなので、Keycloak でも Google でも同じはずです
(**実機で当てたのは Entra ID だけ**)。

- **認可コードフロー + PKCE (S256)**。`state` と `nonce` も使います
- **ID トークンは署名まで見ます。** 認可コードフローでは TLS 越しに相手から直に
  受け取るので仕様上は省けますが (OIDC Core 3.1.3.7)、省くと安全が
  「トークンをどこから受け取ったか」に乗ります。WebCrypto で数行です
- **受ける署名方式は RS256 だけ。** `alg: none` を受けると署名を見ない道ができます
- 発行元・宛先・期限・合言葉 (`nonce`) を確かめます。時計のずれは60秒まで許します

### グループで決める

**誰がログインしたかでは決めません。** 人が増えても denpa 側を触らずに済みます。

Entra ID でグループを載せるには、**アプリ登録の「トークン構成」で
`groupMembershipClaims` を有効に**してください。既定で載るのは
**グループのオブジェクトID (GUID)** なので、`OIDC_GROUP` にもそれを書きます。

```sh
OIDC_GROUP=6f1b2c3d-4e5f-6789-abcd-ef0123456789
```

断るときは理由を画面に出します。**黙って弾くと「なぜか自分だけ入れない」になる**ためです。

| 出るもの | 意味 |
| --- | --- |
| `... のグループに入っていません` | そのとおり |
| `ID トークンに groups がありません` | `groupMembershipClaims` がまだ無効 |
| `グループが多すぎて ID トークンに載っていません` | Entra が `groups` の代わりに `_claim_names` を返した。グループを減らすか、`OIDC_GROUP` を空にして Entra 側のアプリ割り当てで決める |

### LAN からは素通し

`OIDC_BYPASS_CIDR` に書いた範囲から来た人には、ログインを求めません。
LAN 用の名前 (`dp.l.doany.io`) を今までどおり使い続けるためのものです。

> **`ADDRESS_HEADER=x-forwarded-for` を一緒に渡すこと。** 渡さないと adapter-node は
> 接続元として Traefik の Pod の住所を返すので、ここが誰にも当たらず**全員がログインを
> 求められます**。逆に、denpa へ直に届く経路があるとヘッダを詐称できます —
> Pod が Service 経由でしか触れないことが前提です。

書けるのはカンマ区切りで、IPv4 の CIDR (`10.10.0.0/16`) か住所そのまま。
**IPv6 は書いたとおりに一致したときだけ**通します (前置き長での判定は入れていません)。

### ログインの控え

**DBに持ちます** (`sessions`)。署名した Cookie に中身を入れる手もありますが、それだと
「この端末だけ切る」ができません。Cookie に入るのは推測できない32バイトだけです。

- `httpOnly` / `SameSite=Lax` / https のときは `Secure`
- 切れたものは `RECONCILE_INTERVAL` ごとに片付けます (読む側は先に無視しています)
- **ログアウトはこちらの控えを消すだけ**で、Entra 側からは出しません。
  `end_session_endpoint` へ送ると、同じ Entra で入っている他のものまで巻き添えで
  切れるためです

### Entra ID 側の用意

1. **アプリの登録**を作る (シングルテナントでよい)
2. **リダイレクト URI** を「Web」で登録する。**denpa の名前ごとに1つずつ**要ります
   (`https://dp.doany.io/login/callback` と `https://dp.l.doany.io/login/callback`)
3. **クライアントシークレット**を作る
4. **トークン構成**で `groupMembershipClaims` を有効にする (グループで絞るなら)

### 前段の forward-auth はどうするか

**denpa 自身がログインさせるようになったら、`k3s/ingress.yaml` の
`forward-auth` と `forward-auth-errors` は外せます。** ただし**実機で通してから**に
してください — 外したあとに OIDC の設定を間違えていると、誰も入れない状態ではなく
**誰でも入れる状態**になります。

順番としては「denpa 側を設定 → 入れることを確かめる → ingress から外す」です。
