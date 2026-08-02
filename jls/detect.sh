#!/bin/sh
#
# join_logo_scp で CM 位置を出す。
#
#   detect.sh <入力TS> [局名] [x,y,w,h]
#
# 最後に「残す区間を Trim() で並べた avs」のパスを標準出力へ出す。
# denpa (src/lib/server/cm-jls.ts) はそれを読んで秒の区間に直す。
#
# 本家の実行役は Node のアプリだが、やっていることは下の3コマンドを順に
# 呼ぶだけなので、そこだけ持ってきてある。
#
#   1. chapter_exe … 無音とシーンチェンジを拾う
#   2. logoframe   … 局ロゴが出ているコマを拾う
#   3. join_logo_scp … その2つを突き合わせて本編とCMに分ける
#
# 局名を渡すと logoframe が**ロゴデータ (.lgd) を自分で作って覚える**。
# 1本目は作るぶん遅く、2本目からはそれを使い回す。合致率が落ちたら作り直す。
set -eu

input=${1:?usage: detect.sh <input.ts> [channel] [x,y,w,h]}
channel=${2:-}
# ロゴの位置。自動で見つからない局だけ、denpa の画面から教わったものが入る
area=${3:-${JLS_LOGO_AREA:-}}

BIN=${JLS_BIN:-/opt/jls/bin}
JL=${JLS_JL:-/opt/jls/JL/JL_標準.txt}
LOGO_DIR=${JLS_LOGO_DIR:-/app/data/logos/jls}
# 生成に使うコマ数。増やすほどロゴが綺麗に出るが、その分だけ読む
SAMPLES=${JLS_LOGO_SAMPLES:-600}

mkdir -p "$LOGO_DIR"

# 作業ファイルは入力の隣に置く。TSと同じ場所なら容量の心配が要らない
base=$input.jls
scp=$base.chapterexe.txt
frames=$base.logoframe.txt
erase=$base.logoerase.avs
cut=$base.cut.avs
scpout=$base.jlscp.txt

cleanup() {
    rm -f "$scp" "$frames" "$erase" "$scpout"
}
trap cleanup EXIT

"$BIN/chapter_exe" -v "$input" -s 8 -e 4 -o "$scp" >&2

if [ -n "$channel" ]; then
    "$BIN/logoframe" "$input" -oa "$frames" -o "$erase" \
        -channel "$channel" -logo-dir "$LOGO_DIR" -logo-samples "$SAMPLES" \
        ${area:+-logo-area "$area"} >&2
else
    # 局が分からないときは持っているロゴを全部当てる。無ければロゴ無しで進む
    "$BIN/logoframe" "$input" -oa "$frames" -o "$erase" -logo "$LOGO_DIR" >&2
fi

"$BIN/join_logo_scp" -inlogo "$frames" -inscp "$scp" -incmd "$JL" \
    -o "$cut" -oscp "$scpout" >&2

# 最後にパスだけ出す。denpa はこれを拾って読む
echo "$cut"
