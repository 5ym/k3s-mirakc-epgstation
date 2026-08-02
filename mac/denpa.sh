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
# 受け口になる小さなアプレットを作る。中身は「リンクを play.sh に渡す」だけ。
# osacompile は macOS に最初から入っているので、入れるものは無い。
#
# Windows 版 (windows/denpa.ps1) と同じリンクを受け取る。
set -eu

APP=${DENPA_APP:-$HOME/Applications/denpa.app}
SUPPORT=${DENPA_SUPPORT:-$HOME/Library/Application Support/denpa}
HANDLER=$SUPPORT/play.sh
BUNDLE_ID=io.denpa.handler
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# 確認なしで開くことを許す denpa の origin
ORIGINS=${DENPA_ORIGINS:-'http://dp.home.arpa,https://dp.doany.io'}

here=$(cd "$(dirname "$0")" && pwd)

usage() {
    sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
}

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

base64url() {
    printf %s "$1" | openssl base64 -A | tr -- '+/' '-_' | tr -d '='
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

install_handler() {
    [ -f "$here/play.sh" ] || { echo "play.sh が見つかりません: $here" >&2; exit 1; }
    mkdir -p "$SUPPORT"
    cp "$here/play.sh" "$HANDLER"
    chmod +x "$HANDLER"
}

install_applet() {
    command -v osacompile >/dev/null 2>&1 || { echo 'macOS でのみ登録できます。' >&2; exit 1; }

    script=$(mktemp -t denpa)
    # リンクは open location で届く。argv では来ない
    cat >"$script" <<EOF
on open location this_URL
    try
        do shell script quoted form of "$HANDLER" & " " & quoted form of this_URL
    on error message number code
        if code is not -128 then display alert "denpa" message message
    end try
end open location
EOF

    rm -rf "$APP"
    mkdir -p "$(dirname "$APP")"
    osacompile -o "$APP" "$script"
    rm -f "$script"

    plist=$APP/Contents/Info.plist
    /usr/libexec/PlistBuddy \
        -c "Add :CFBundleIdentifier string $BUNDLE_ID" \
        -c 'Add :CFBundleURLTypes array' \
        -c 'Add :CFBundleURLTypes:0 dict' \
        -c 'Add :CFBundleURLTypes:0:CFBundleURLName string denpa' \
        -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' \
        -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string denpa' \
        -c 'Add :LSUIElement bool true' \
        -c 'Add :LSBackgroundOnly bool false' \
        "$plist" >/dev/null

    # 作ったばかりのバンドルは Launch Services が知らない。教えておく
    [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1
    echo "登録しました: $APP"
}

case ${1:---install} in
    --remove) remove ;;
    --show) show ;;
    --test) test_link "${2:-}" ;;
    --help | -h) usage ;;
    --install)
        install_handler
        install_applet
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
