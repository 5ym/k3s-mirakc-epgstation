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
| `/api/live/socket` | **使い捨ての札** (下記)。ここだけ SvelteKit に届きません |
| それ以外 (画面と API) | **OIDC** (設定してあれば)。無ければベーシック認証 |
| `/login` `/login/callback` `/login/out` `/logout` | 素通し |
| `/api/health` | 素通し |
| `/manifest.webmanifest` | 素通し |

**`/api/live/socket` だけは前段の `Bun.serve` が受けます** (`server.js`)。bun の
`node:http` では WebSocket の握手ができないためで、SvelteKit の `hooks.server.ts` には
届かない = **ここに書いてある守り方が効きません**。

**ブラウザは WebSocket の握手に `Authorization` を付けてくれない**ので、そのままだと
チューナーを掴む口が素通しになります。画面が先に `POST /api/live/ticket` で
使い捨ての札を取り、それを URL に付けて繋ぎます。**札の発行は普通の HTTP** なので、
ベーシック認証も OIDC も信頼した網もそのまま効きます。1回使ったら消し (URL は履歴にも
ログにも残る)、寿命は30秒 (`src/lib/server/tickets.ts`、[stream.md](stream.md#繋ぐときの認証))。

**`/api/health` を守ると Pod が再起動を繰り返します。** Kubernetes の `livenessProbe`
が叩く口で、掛ける範囲を選べるのをやめたときに実際に踏みました
(E2E のスタックが起動待ちで固まって気付いた)。出しているのは「生きているか・局が何件か・
録画が何本か」だけです。

**`/manifest.webmanifest` を守るとホーム画面の名前が付きません。** ブラウザは
マニフェストを**資格情報を付けずに**取りに来るので、掛けると 401 で落ちます。
中身は表示名と色だけです ([player.md](player.md#ホーム画面に置く))。

**プレイヤーはリダイレクトを扱えません。** VLC も Kodi も Infuse も、ログイン画面へ
飛ばされたところで何もできず「再生できません」で終わります。だからファイルを取りに
来る口だけは、前段に何を置いていようと素のベーシック認証のまま残してあります。

**OIDC を入れると、画面のぶんはベーシック認証から OIDC に移ります。** 両方掛けると、
ブラウザの認証ダイアログを閉じないとログイン画面にすら行けないためです。
ファイルの口はどちらにせよベーシック認証のままなので、守りに穴は空きません。

## ベーシック認証は、無ければ起動時に作る

**何も設定しなくても掛かった状態で上がります。** 以前は設定するまで**録画も WebDAV も
誰でも取れる状態**で、しかも「あとで掛ける」を忘れたことに気付く手立てがありませんでした。

作ったパスワードは**起動のログに1度だけ**出します。掛かった以上どこかで受け取れないと、
立てた本人が自分の画面に入れません。

```text
[boot] ベーシック認証を作りました: denpa / abYHnrdeniq7npvdZNkakKQV
       設定画面から見直せます。プレイヤー (VLC / Kodi) にも同じものを入れてください
```

以降は設定画面 (`/settings`) で見られます。**2度目の起動では作り直しません。**

- **ユーザー名は `denpa` 固定。** 変えて嬉しいことが無く、忘れると登録済みの端末が
  全部つながらなくなります
- **記号は使いません。** このパスワードは**再生リンクのURLに埋め込まれる**ので、
  `:` `@` `/` `#` `?` が入ると URL として割れます。紛らわしい文字 (0/O、1/l/I) も
  外してあります (Kodi の画面で手入力することがあるため)
- **空にはできません。** 空にすると誰でも取れる状態に戻り、しかもそうなったことが
  画面から分かりません。消したいのではなく変えたいなら「作り直す」を押します

> **作り直すと、押した端末はその場で入れなくなります。** 画面にも認証が掛かっている
> ので、ブラウザが持っている古いほうでは次の読み込みから 401 です。新しいものを
> 受け取る道が画面しか無いと押した本人が締め出されるので、**作り直したぶんは
> ログにも出しています**。
>
> ```text
> [auth] パスワードを作り直しました: denpa / xxxxxxxx
> ```
>
> **OIDC を設定してあれば起きません** — 画面はそちらが守っているので、
> ベーシック認証を作り直しても画面には入ったままです。

### 掛かる範囲は選べません

以前は「配信と WebDAV だけ / 画面も含めて全部」を選べて、**既定が前者**でした。
その既定だと画面が誰にでも開き、しかも**再生リンクのURLにパスワードが埋まっている**ので、
画面を開ければ全部見えます。掛かっているつもりでいられる設定だったので、無くしました。

**掛けたら全部に掛かります。** 唯一の例外が OIDC で、そのときだけ画面をそちらに譲ります。

### 初回から OIDC を設定してあるとき

**両方が同時に立ちます。** ベーシック認証は起動時に作られてファイルの口を守り、
画面は OIDC が守ります。実際に立てて確かめた振る舞い:

| 叩いた先 | 資格情報なし | |
| --- | --- | --- |
| 画面 (ブラウザ) | **302 → `/login`** | OIDC へ |
| 画面 (ベーシック認証だけ持って) | **302 → `/login`** | 素通りはできない |
| `/dav/` | **401** | ベーシック認証 |
| `/api/recordings/<id>/file` | **401** | ベーシック認証 |
| `/dav/` (資格情報あり) | 207 | 通る |

## OIDC でのログイン

**3つ揃ったときだけ有効**になります。揃っていなければ画面もベーシック認証で守ります
(掛かる範囲は上のとおり、全部)。

| 変数 | |
| --- | --- |
| `OIDC_ISSUER` | 例 `https://login.microsoftonline.com/<tenant>/v2.0` |
| `OIDC_CLIENT_ID` | アプリ登録のアプリケーションID |
| `OIDC_CLIENT_SECRET` | クライアントシークレット |
| `OIDC_GROUP` | **このグループに居る人だけ通す。** 空なら入れた人は全員 |
| `TRUSTED_NETWORKS` | **何も聞かずに通す網** (例 `10.10.0.0/16`)。下記 |
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

## 網の中なら、何も聞かない

**`TRUSTED_NETWORKS` に当たると、ベーシック認証も OIDC も掛かりません。**
LAN のプレイヤー (VLC / Kodi / Infuse) に資格情報を入れずに使わせるためのものです。

```sh
TRUSTED_NETWORKS=10.10.0.0/16
# いくつでも並べられる
TRUSTED_NETWORKS=10.10.0.0/16,10.20.0.0/16,192.168.1.5
```

**見るのは住所だけです。どの名前で来たかは問いません** — LAN から外向きの
`dp.doany.io` を開いても、そのまま通ります。名前で分けるのは前段 (Traefik) の
仕事で、LAN 用の名前 `dp.l.doany.io` には `ClientIP(10.10.0.0/16)` を条件に
付けてあります (`k3s/ingress.yaml`)。同じ条件を二か所に書くと、片方だけ直して
食い違うほうが危ないので、こちらでは持ちません。

> **`ADDRESS_HEADER=x-forwarded-for` を一緒に渡すこと。** 渡さないと adapter-node は
> 接続元として Traefik の Pod の住所を返すので、住所の側が誰にも当たりません
> (=全員が認証を求められます)。逆に、denpa へ直に届く経路があるとヘッダを
> 詐称できます — Pod が Service 経由でしか触れないことが前提です。
>
> **読めなかったときは通しません。** 分からないほうを通すと、ヘッダを外すだけで
> 認証を抜けられてしまいます。

網の書き方は IPv4 の CIDR (`10.10.0.0/16`) か住所そのまま。
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

> **リダイレクト URI は authorize を叩いても確かめられません。** 未登録の URI でも
> Entra はまずログイン画面を返し、**認証が済んでから** `AADSTS50011` を出します
> (出鱈目な URI を対照にして確認済み)。**登録してあることは Azure の画面で見るしか
> ありません。**

#### この構成で実際に使っている値

**oauth2-proxy (`auth` 名前空間) と同じアプリ登録を使い回しています。** テナントも
グループも同じなので、入れる人の集合は forward-auth のときと変わりません。

値は **`denpa` 名前空間の Secret `denpa-oidc`** に入っていて、`k3s/deployment.yaml`
はそれを `secretKeyRef` で引くだけです。

| 鍵 | 何 |
| --- | --- |
| `issuer` | `OAUTH2_PROXY_OIDC_ISSUER_URL` と同じ |
| `client-id` | `OAUTH2_PROXY_CLIENT_ID` と同じ |
| `client-secret` | `auth/auth-secrets` の `oidc-client-secret` を写したもの |
| `group` | `OAUTH2_PROXY_ALLOWED_GROUPS` と同じ |

#### 封をして git に置いてあります

**`k3s/oidc-sealed.yaml` は SealedSecret です。** クラスタの中の鍵でしか開けないので、
公開リポジトリに置いても中身は読めません。`kube-system` の
`sealed-secrets-controller` がこれを見て Secret `denpa-oidc` を作ります。

そうする理由は、**手で作った Secret がどこにも書かれていない状態を無くす**ためです。
クラスタを立て直したら、他は全部 ArgoCD が git から戻すのに、これだけ手順を
思い出して打ち直すことになります。

**名前と名前空間を変えると開けなくなります** (既定の scope が `denpa/denpa-oidc` を
鍵の一部にしているため)。移すときは封をし直します。

作り直すときは `~/bootstrap/kubeseal.sh` に通します。

```sh
umask 077
cat > /tmp/oidc.yaml <<'YAML'
apiVersion: v1
kind: Secret
metadata: { name: denpa-oidc, namespace: denpa }
type: Opaque
stringData:
  issuer: "..."
  client-id: "..."
  client-secret: "..."
  group: "..."
YAML
~/bootstrap/kubeseal.sh /tmp/oidc.yaml k3s/oidc-sealed.yaml && rm /tmp/oidc.yaml
```

**平文の Secret が先にあると、controller は上書きしません。** 自分が作ったもので
なければ触らない作りです。引き取らせるには印を付けます (この構成では実施済み)。

```sh
kubectl -n denpa annotate secret denpa-oidc sealedsecrets.bitnami.com/managed=true
```

> **グループが載ってくるかは、入ってみるまで分かりません。** oauth2-proxy が
> `ALLOWED_GROUPS` で絞れている以上、載っている見込みは高いのですが、あちらは
> 載っていなければ Graph に聞きに行く作りなので**証拠にはなりません**。
> 載っていなければ denpa は理由を出して断るので、そこで分かります
> (「ID トークンに groups がありません」)。

### 前段の forward-auth は外しました

`k3s/ingress.yaml` から `forward-auth` と `forward-auth-errors` (oauth2-proxy) を
落としてあります。denpa が自分でログインさせるので、前段に置く理由がなくなりました。

**順番が大事です。** 「denpa 側を設定 → **実機で入れることを確かめる** → ingress から
外す」。先に外すと、OIDC の設定を間違えていたときに*誰も入れない*ではなく
**誰でも入れる**状態になります。

外したことで、`dp.doany.io` のルートは1つに戻りました。2つに割れていたのは
「配信と WebDAV だけ forward-auth を通さない」ためで、その仕分けは
いま denpa 側 (`auth.ts`) がやっています。

> **oauth2-proxy 自体は残っています。** 同じアプリ登録を他のもの (Mattermost など)
> も使っているので、`auth` 名前空間には手を触れていません。
