#!/usr/bin/env bash
# 偽 recisdb。E2E で「掛かったまま録れたTSを、エンコードの前に解く」ところを通す。
# 本物と同じく `recisdb decode -i <input> <output>` の形で呼ばれる。
set -uo pipefail

output="${!#}"
input=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "-i" ]; then input="$arg"; fi
    prev="$arg"
done

if [ -z "$input" ] || [ ! -f "$input" ]; then
    echo "input not found: $input" >&2
    exit 1
fi

# 4バイト目の transport_scrambling_control を落とすだけ。本物の復号はしない
mkdir -p "$(dirname "$output")"
bun -e '
const { readFileSync, writeFileSync } = require("node:fs");
const buffer = readFileSync(process.argv[1]);
for (let i = 0; i + 188 <= buffer.length; i += 188) buffer[i + 3] &= 0x3f;
writeFileSync(process.argv[2], buffer);
' "$input" "$output"
