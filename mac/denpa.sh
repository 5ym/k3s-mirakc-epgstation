#!/bin/sh
#
# denpa の「再生」ボタンから VLC を開けるようにする (macOS)。
#
#   sh denpa.sh            登録
#   sh denpa.sh --test     実際に開いてみる
#   sh denpa.sh --show     登録されている中身を見る
#   sh denpa.sh --remove   解除
#
# macOS では URL スキームを名乗れるのは**アプリケーションバンドルだけ**なので、
# 受け口になる小さなアプレットを作る。中身は「届いたリンクをこのスクリプト自身に
# 渡す」だけ。osacompile は macOS に最初から入っているので、入れるものは無い。
#
# 配るのはこの1本だけ。登録のときに自分自身を控えの場所へ写し、アプレットからは
# その写しを叩く (Windows 版がレジストリの値1行で済ませているところ)。
#
# リンクの形は Windows 版 (windows/denpa.ps1) と同じ。
set -eu

APP=${DENPA_APP:-$HOME/Applications/denpa.app}
SUPPORT=${DENPA_SUPPORT:-$HOME/Library/Application Support/denpa}
HANDLER=$SUPPORT/denpa.sh
BUNDLE_ID=io.denpa.handler
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
VLC=${DENPA_VLC:-/Applications/VLC.app/Contents/MacOS/VLC}

# 確認なしで開くことを許す denpa の origin
ORIGINS=${DENPA_ORIGINS:-'http://dp.home.arpa,https://dp.doany.io'}

usage() {
    sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
}

# 黙って終わると「押しても何も起きない」になる。必ず見えるようにする
fail() {
    if command -v osascript >/dev/null 2>&1; then
        osascript -e "display alert \"denpa\" message \"$1\"" >/dev/null 2>&1 || true
    fi
    echo "denpa: $1" >&2
    exit 1
}

# base64url を戻す。パディングを足さないと base64 が受け付けない
decode() {
    s=$(printf %s "$1" | tr -- '-_' '+/')
    case $((${#s} % 4)) in
        2) s="${s}==" ;;
        3) s="${s}=" ;;
    esac
    printf %s "$s" | openssl base64 -d -A
}

base64url() {
    printf %s "$1" | openssl base64 -A | tr -- '+/' '-_' | tr -d '='
}

# --- リンクを受け取って VLC に渡す ----------------------------------------

play() {
    link=$1
    case $link in
        denpa://play/*/?title=*) ;;
        *) fail "リンクを読めません: $link" ;;
    esac

    rest=${link#denpa://play/}
    data=${rest%%/*}
    title_data=${rest#*/?title=}

    # 中身は base64url だけ。外から渡ってくるものなので、そのまま展開しない
    for part in "$data" "$title_data"; do
        case $part in
            *[!A-Za-z0-9_-]*) fail "リンクの中身が読めません" ;;
        esac
    done
    [ -n "$data" ] || fail "リンクの中身が読めません"

    url=$(decode "$data")
    # 番組名の " は引用をこわすので落とす。EPG の記号は当てにできない
    title=$(decode "$title_data" | tr -d '"')

    # 外から渡ってくるリンクなので、file:// などは食わせない
    case $url in
        http://* | https://*) ;;
        *) fail "http(s) 以外は開きません" ;;
    esac

    [ -x "$VLC" ] || fail "VLC が見つかりません: $VLC"

    # 背景に回す。前に出したままだと、呼び出し元(アプレット)が VLC の終了まで待つ
    "$VLC" --no-video-title-show --meta-title="$title" "$url" >/dev/null 2>&1 &
}

# --- 登録・解除 -----------------------------------------------------------

remove() {
    rm -rf "$APP" "$SUPPORT"
    # 消したことを Launch Services にも伝える。残っていると古いほうが呼ばれる
    [ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$APP" >/dev/null 2>&1
    for domain in com.google.Chrome com.microsoft.Edge; do
        defaults delete "$domain" AutoLaunchProtocolsFromOrigins >/dev/null 2>&1 || true
    done
    echo '解除しました。'
}

show() {
    if [ -d "$APP" ]; then
        echo "アプレット: $APP"
        /usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "$APP/Contents/Info.plist" 2>/dev/null || true
    else
        echo '登録されていません。'
    fi
    [ -f "$HANDLER" ] && echo "渡し役: $HANDLER"
    for domain in com.google.Chrome com.microsoft.Edge; do
        printf '%s: ' "$domain"
        defaults read "$domain" AutoLaunchProtocolsFromOrigins 2>/dev/null || echo '(ポリシー未設定)'
    done
}

test_link() {
    target=${1:-https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4}
    link="denpa://play/$(base64url "$target")/?title=$(base64url 'denpa テスト')"
    echo "開くリンク: $link"
    open "$link"
}

<<'NOTE' true
ブラウザに「この origin からの denpa:// は確認なしで開いてよい」と教える。

独自スキームを開くとき、Chrome も Edge も既定で毎回確認を出す。黙らせる方法は
ポリシー (AutoLaunchProtocolsFromOrigins) しかない。macOS では管理者権限が要らず、
ユーザーの設定ドメインに書ける。反映にはブラウザの再起動が要る。
NOTE
allow_origins() {
    entries=$(printf %s "$ORIGINS" | tr ',' '\n' | sed 's/.*/"&"/' | paste -sd, -)
    for domain in com.google.Chrome com.microsoft.Edge; do
        defaults write "$domain" AutoLaunchProtocolsFromOrigins \
            "[{\"protocol\":\"denpa\",\"allowed_origins\":[$entries]}]" >/dev/null 2>&1 ||
            echo "$domain: ポリシーを書けませんでした (再生自体はできます)"
    done
    echo "確認なしで開く origin: $ORIGINS"
}

install_scheme() {
    command -v osacompile >/dev/null 2>&1 || { echo 'macOS でのみ登録できます。' >&2; exit 1; }

    # 自分自身を控えておく。配布物を消したり移したりしても壊れないように
    mkdir -p "$SUPPORT"
    cp "$0" "$HANDLER"
    chmod +x "$HANDLER"

    script=$(mktemp -t denpa)
    # リンクは open location で届く。argv では来ない
    cat >"$script" <<EOF
on open location this_URL
    try
        do shell script "/bin/sh " & quoted form of "$HANDLER" & " --play " & quoted form of this_URL
    on error message number code
        if code is not -128 then display alert "denpa" message message
    end try
end open location
EOF

    rm -rf "$APP"
    mkdir -p "$(dirname "$APP")"
    osacompile -o "$APP" "$script"
    rm -f "$script"

    /usr/libexec/PlistBuddy \
        -c "Add :CFBundleIdentifier string $BUNDLE_ID" \
        -c 'Add :CFBundleURLTypes array' \
        -c 'Add :CFBundleURLTypes:0 dict' \
        -c 'Add :CFBundleURLTypes:0:CFBundleURLName string denpa' \
        -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' \
        -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string denpa' \
        -c 'Add :LSUIElement bool true' \
        "$APP/Contents/Info.plist" >/dev/null

    # 作ったばかりのバンドルは Launch Services が知らない。教えておく
    [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1
    echo "登録しました: $APP"
}

case ${1:---install} in
    --play) shift; play "${1:-}" ;;
    --remove) remove ;;
    --show) show ;;
    --test) test_link "${2:-}" ;;
    --help | -h) usage ;;
    --install)
        install_scheme
        allow_origins
        echo ''
        echo '確認を出さずに開くには、ブラウザを一度終了してから開き直してください。'
        echo '確認は sh denpa.sh --test'
        echo '解除は sh denpa.sh --remove'
        ;;
    *)
        usage
        exit 1
        ;;
esac
