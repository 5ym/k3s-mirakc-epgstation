#!/bin/sh
#
# denpa:// のリンクを1つ受け取って VLC に渡す。
#
#   denpa://play/<base64url>/?title=<base64url>
#
# 登録は denpa.sh がやる。ここはリンクを解いて渡すだけなので、macOS でなくても
# 走る (mac/verify.sh で確かめている)。
#
# VLC の場所は DENPA_VLC で差し替えられる。
set -eu

VLC=${DENPA_VLC:-/Applications/VLC.app/Contents/MacOS/VLC}

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

[ $# -eq 1 ] || fail "リンクが渡っていません"
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
