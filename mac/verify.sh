#!/bin/sh
#
# play.sh がリンクを解いて VLC に渡せるか確かめる。
#
# アプレットの登録 (osacompile / PlistBuddy) は macOS でしか走らないが、
# 一番壊れやすいのはリンクの復号と引数の渡し方なので、そこだけは
# どこでも確かめられるようにしてある。
#
#   sh mac/verify.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# VLC の代わり。渡された引数を1行1つで書き出す
cat >"$work/vlc" <<'EOF'
#!/bin/sh
: >"$0.args"
for arg in "$@"; do printf '%s\n' "$arg" >>"$0.args"; done
EOF
chmod +x "$work/vlc"

b64() { printf %s "$1" | openssl base64 -A | tr -- '+/' '-_' | tr -d '='; }

play() {
    rm -f "$work/vlc.args"
    DENPA_VLC="$work/vlc" sh "$here/play.sh" "$1"
    # 背景に回して起動するので、書き終わるのを少しだけ待つ
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        [ -f "$work/vlc.args" ] && return 0
        sleep 0.2
    done
    return 0
}

url='http://denpa:p%40ss@dp.home.arpa/api/recordings/12/file'
title='アニメ 青のオーケストラ シーズン2(20)「超える」'
link="denpa://play/$(b64 "$url")/?title=$(b64 "$title")"

play "$link"
[ -f "$work/vlc.args" ] || { echo 'VLC が呼ばれませんでした' >&2; exit 1; }
echo '引数:'
sed 's/^/  /' "$work/vlc.args"

# 番組名は空白を含む。1つの引数として渡らないと、後ろがもう1つの入力になって
# VLC が「開けません」と言う
count=$(grep -c -- '--meta-title=' "$work/vlc.args" || true)
[ "$count" = 1 ] || { echo 'タイトルが1つの引数になっていない' >&2; exit 1; }
grep -qxF -- "--meta-title=$title" "$work/vlc.args" || { echo 'タイトルが復元できていない' >&2; exit 1; }
grep -qxF -- "$url" "$work/vlc.args" || { echo 'URLを復元できていない' >&2; exit 1; }
echo '=> 復号して VLC に渡せている'

# --- 通してはいけないリンク -----------------------------------------------

bad_link() {
    rm -f "$work/vlc.args"
    if DENPA_VLC="$work/vlc" sh "$here/play.sh" "$2" >/dev/null 2>&1; then
        echo "通してはいけないものが通った: $1" >&2
        exit 1
    fi
    sleep 0.2
    [ ! -f "$work/vlc.args" ] || { echo "VLC まで届いた: $1" >&2; exit 1; }
    echo "弾いた: $1"
}

bad_link 'http(s) ではない' "denpa://play/$(b64 'file:///etc/passwd')/?title="
bad_link '形が違う' 'denpa://open/aaaa/'
bad_link 'base64url ではない' 'denpa://play/!!!!/?title='

echo ''
echo 'すべて通りました。'
