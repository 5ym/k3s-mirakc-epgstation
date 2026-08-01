#!/usr/bin/env bash
# 偽 ffmpeg。E2E で「エンコードが走って mkv が出来る」ところまでを実 ffmpeg 無しで通す。
# 本物と同じく stderr に Duration を、stdout に -progress の key=value ブロックを吐く。
set -uo pipefail

output="${!#}"   # 最後の引数が出力ファイル
input=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "-i" ]; then input="$arg"; fi
    prev="$arg"
done

# CM検出パス (silencedetect) は本編とは別物として応答する。
# 300秒と360秒に境界が来るので、300-360 の 60 秒がCMブロックとして検出される。
if printf '%s\n' "$@" | grep -q silencedetect; then
    echo "  Duration: 00:10:00.00, start: 0.000000, bitrate: 15000 kb/s" >&2
    echo "[silencedetect @ 0x1] silence_start: 299.8" >&2
    echo "[silencedetect @ 0x1] silence_end: 300.2 | silence_duration: 0.4" >&2
    echo "[silencedetect @ 0x1] silence_start: 359.8" >&2
    echo "[silencedetect @ 0x1] silence_end: 360.2 | silence_duration: 0.4" >&2
    exit 0
fi

# ライブ配信(TS): stdin をそのまま stdout に流し続ける。
# 中身は本物のTSではないが、「切るまで流れ続ける」という性質だけは同じ
if [ "$output" = "pipe:1" ]; then
    exec cat
fi

echo "Input #0, mpegts, from '${input}':" >&2
echo "  Duration: 00:00:10.00, start: 0.000000, bitrate: 15000 kb/s" >&2

if [ "${FAKE_FFMPEG_FAIL:-0}" = "1" ]; then
    echo "Error while opening encoder - fake failure" >&2
    exit 1
fi

steps="${FAKE_FFMPEG_STEPS:-4}"
for i in $(seq 1 "$steps"); do
    out_time_us=$((i * 10000000 / steps))
    printf 'frame=%d\nfps=120\nbitrate=2000.0kbits/s\ntotal_size=%d\nout_time_us=%d\nspeed=8.0x\ndrop_frames=0\nprogress=continue\n' \
        "$((i * 300))" "$((i * 1000000))" "$out_time_us"
    sleep 0.2
done

mkdir -p "$(dirname "$output")"
# 中身は問わないが、サイズ0だと「失敗」と見分けが付かないので少しだけ書く
head -c 4096 /dev/zero > "$output"

printf 'frame=1200\nfps=120\nbitrate=2000.0kbits/s\ntotal_size=4096\nout_time_us=10000000\nspeed=8.0x\ndrop_frames=0\nprogress=end\n'
exit 0
