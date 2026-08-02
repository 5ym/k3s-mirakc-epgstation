#!/bin/bash
# B-CASカードは PC/SC 経由で読む。recisdb は既定で ARIB STD-B25 を復号するが、
# カードが開けないときは黙って復号せずに素通しする(--exit-on-card-error を
# 付けない限り止まらない)。pcscd が居ないと全部スクランブルされたまま録れてしまい、
# 録画は成功するのに一切デコードできない、という分かりにくい壊れ方をする。
set -eu

if ! pgrep -x pcscd > /dev/null 2>&1; then
    pcscd --disable-polkit 2>/dev/null || pcscd || true
fi

# 設定は PVC に置く。チャンネルスキャンの結果が Mirakurun 自身によって
# ここへ書き戻され、Pod を作り直しても残る。
# イメージが持っているのは雛形で、まだ無いものだけを初回に写す。
# 既にあるものは触らない(画面から変えた設定を巻き戻さないため)。
mkdir -p /app-config
for file in /app-config-defaults/*; do
    name="$(basename "$file")"
    if [ ! -e "/app-config/$name" ]; then
        cp "$file" "/app-config/$name"
        echo "[entrypoint] 初期設定を置きました: $name"
    fi
done

exec /bin/bash ./docker/container-init.sh "$@"
