#!/bin/bash
# B-CASカードは PC/SC 経由で読む。recisdb は既定で ARIB STD-B25 を復号するが、
# カードが開けないときは黙って復号せずに素通しする(--exit-on-card-error を
# 付けない限り止まらない)。pcscd が居ないと全部スクランブルされたまま録れてしまい、
# 録画は成功するのに一切デコードできない、という分かりにくい壊れ方をする。
set -eu

if ! pgrep -x pcscd > /dev/null 2>&1; then
    pcscd --disable-polkit 2>/dev/null || pcscd || true
fi

exec /bin/bash ./docker/container-init.sh "$@"
