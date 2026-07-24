#!/bin/sh
set -eu

export LANG=C.UTF-8

readonly CONFIG_FILE="${CONFIG_FILE:-/etc/mirakc/config.yml}"
readonly EXTRACT_SID="${EXTRACT_SID:-0}"

# recisdbでチューナーを直接叩くため、mirakcのチューナー管理を経由しない。
# 手動実行(kubectl exec)前提。使用中のチューナーは録画中でも問答無用で奪う
# (evict_tuner_user参照)。録画中かどうかの判断は実行する人間の責任。
readonly MIRAKC_URL="${MIRAKC_URL:-http://localhost:40772}"

# 1チャンネルあたりの上限秒数。recisdbは時間指定なしだと自分では終了しない
# (Recording duration: Infinite)ので、これが唯一の終了手段。とはいえ実際は
# 無信号なら7秒ほどでrecisdbが自力終了し、信号があればロック後数秒でサービ
# ス取得完了するので、ここまでかかることは稀(想定外に詰まった時の上限値)。
readonly SCAN_TIMEOUT_GR="${SCAN_TIMEOUT_GR:-30}"
readonly SCAN_TIMEOUT_BS="${SCAN_TIMEOUT_BS:-40}"
readonly SCAN_TIMEOUT_CS="${SCAN_TIMEOUT_CS:-30}"

# チューナーごとのチューニングコマンドのテンプレート。標準出力にTSを流す。
# <channel> はチャンネル名に置換される。
# --timeは付けない: recisdb自身の時間制限は当てにならず(発火しないことが
# ある)、実際に効いているのは外側のtimeout+FIFO即kill(scan_channel参照)
# だけなので付けても付けなくても挙動は同じと実測済み。
readonly RECORD_COMMAND_GR_A='recisdb tune --device /dev/dvb/adapter1/frontend0 --channel <channel> --no-decode -'
readonly RECORD_COMMAND_GR_B='recisdb tune --device /dev/dvb/adapter3/frontend0 --channel <channel> --no-decode -'
readonly RECORD_COMMAND_BS_A='recisdb tune --device /dev/dvb/adapter0/frontend0 --channel <channel> --no-decode -'
readonly RECORD_COMMAND_BS_B='recisdb tune --device /dev/dvb/adapter2/frontend0 --channel <channel> --no-decode -'
readonly RECORD_COMMAND_CS_A='recisdb tune --device /dev/dvb/adapter0/frontend0 --channel <channel> --no-decode -'
readonly RECORD_COMMAND_CS_B='recisdb tune --device /dev/dvb/adapter2/frontend0 --channel <channel> --no-decode -'

# "<prefix><n>" を n=from..to で生成
seq_channels() {
  prefix="$1"
  n="$2"
  to="$3"
  while [ "${n}" -le "${to}" ]; do
    echo "${prefix}${n}"
    n=$((n + 1))
  done
}

# 走査対象: GR(地上波T13-62、CATV C13-63)
CHANNELS_GR="$(
  seq_channels T 13 62
  seq_channels C 13 63
)"
readonly CHANNELS_GR=$(echo "${CHANNELS_GR}" | grep -e '^[^#]')

# 走査対象: BS
# 奇数スロット1-23が有効だが、7と17はISDB-S3(4K8K)でrecisdbが受け付けない
# (channels.rsで明示的に拒否)。各スロットのサブ番号は0-7まで有効
# (RelTsNumの範囲、これもchannels.rs準拠)。実際に放送があるかどうかは
# scan_channelで確認するので、ここではrecisdbが受理する組み合わせを
# 全部生成する(過不足なし)。
CHANNELS_BS="$(
  slot=1
  while [ "${slot}" -le 23 ]; do
    if [ "${slot}" -ne 7 ] && [ "${slot}" -ne 17 ]; then
      sub=0
      while [ "${sub}" -le 7 ]; do
        printf 'BS%02d_%d\n' "${slot}" "${sub}"
        sub=$((sub + 1))
      done
    fi
    slot=$((slot + 2))
  done
)"
readonly CHANNELS_BS=$(echo "${CHANNELS_BS}" | grep -e '^[^#]')

# 走査対象: CS(偶数スロット02-24)
CHANNELS_CS="$(
  n=2
  while [ "${n}" -le 24 ]; do
    echo "CS${n}"
    n=$((n + 2))
  done
)"
readonly CHANNELS_CS=$(echo "${CHANNELS_CS}" | grep -e '^[^#]')


require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "require $1" >&2
    exit 1
  fi
}

# 放送波のサービス名は全角の英字・数字・記号・スペースを含む
# (例: "Ｔｏｋｙｏ　ＭＸ－１")。generated `name:` 用にそれらだけ半角化する
# (カナ・漢字は対象外)。trはUTF-8のマルチバイトを壊すことがあるのでsedを
# 使う。半角側がASCII記号を全部含むため、y///では区切り文字と衝突するので
# 1文字ずつs///で置換する。
to_half_width() {
  echo "$1" | sed \
    -e 's/！/!/g; s/＂/"/g; s/＃/#/g; s/＄/$/g; s/％/%/g; s/＆/\&/g; s/＇/'"'"'/g; s/（/(/g; s/）/)/g; s/＊/*/g; s/＋/+/g; s/，/,/g; s/－/-/g; s/．/./g; s/／/\//g' \
    -e 's/０/0/g; s/１/1/g; s/２/2/g; s/３/3/g; s/４/4/g; s/５/5/g; s/６/6/g; s/７/7/g; s/８/8/g; s/９/9/g' \
    -e 's/：/:/g; s/；/;/g; s/＜/</g; s/＝/=/g; s/＞/>/g; s/？/?/g; s/＠/@/g' \
    -e 's/Ａ/A/g; s/Ｂ/B/g; s/Ｃ/C/g; s/Ｄ/D/g; s/Ｅ/E/g; s/Ｆ/F/g; s/Ｇ/G/g; s/Ｈ/H/g; s/Ｉ/I/g; s/Ｊ/J/g; s/Ｋ/K/g; s/Ｌ/L/g; s/Ｍ/M/g; s/Ｎ/N/g; s/Ｏ/O/g; s/Ｐ/P/g; s/Ｑ/Q/g; s/Ｒ/R/g; s/Ｓ/S/g; s/Ｔ/T/g; s/Ｕ/U/g; s/Ｖ/V/g; s/Ｗ/W/g; s/Ｘ/X/g; s/Ｙ/Y/g; s/Ｚ/Z/g' \
    -e 's/［/[/g; s/＼/\\/g; s/］/]/g; s/＾/^/g; s/＿/_/g; s/｀/`/g' \
    -e 's/ａ/a/g; s/ｂ/b/g; s/ｃ/c/g; s/ｄ/d/g; s/ｅ/e/g; s/ｆ/f/g; s/ｇ/g/g; s/ｈ/h/g; s/ｉ/i/g; s/ｊ/j/g; s/ｋ/k/g; s/ｌ/l/g; s/ｍ/m/g; s/ｎ/n/g; s/ｏ/o/g; s/ｐ/p/g; s/ｑ/q/g; s/ｒ/r/g; s/ｓ/s/g; s/ｔ/t/g; s/ｕ/u/g; s/ｖ/v/g; s/ｗ/w/g; s/ｘ/x/g; s/ｙ/y/g; s/ｚ/z/g' \
    -e 's/｛/{/g; s/｜/|/g; s/｝/}/g; s/～/~/g' \
    -e 's/　/ /g'
}

# "--device /dev/dvb/adapterN/frontend0" からadapterN部分だけ取り出す
# (mirakcの/api/tuners の name フィールドと突き合わせるため)
adapter_name_from_cmd() {
  echo "$1" | sed -n 's#.*/dev/dvb/\(adapter[0-9]\+\)/.*#\1#p'
}

# cmdの--deviceが指すチューナーを、今使っているプロセスごと強制的に空ける。
# mirakcの/api/tunersから実際のpidが取れるので、それをkillするだけ
# (録画中でも容赦なくkillする、ヘッダのコメント参照)。mirakcに接続できない
# / 誰も使っていない場合は何もしない。
evict_tuner_user() {
  cmd="$1"
  adapter="$(adapter_name_from_cmd "${cmd}")"
  [ -n "${adapter}" ] || return 0

  info="$(curl -sf "${MIRAKC_URL}/api/tuners" | jq -c --arg name "${adapter}" '.[] | select(.name == $name)' 2>/dev/null)"
  [ -n "${info}" ] || return 0

  pid="$(echo "${info}" | jq -r '.pid')"
  using="$(echo "${info}" | jq -r '.isUsing')"
  [ "${using}" = 'true' ] && [ "${pid}" != 'null' ] && [ -n "${pid}" ] || return 0

  echo "[${adapter}] in use (pid ${pid}), evicting to scan" >&2
  kill "${pid}" 2>/dev/null || true

  i=0
  while [ "${i}" -lt 20 ]; do
    still="$(curl -sf "${MIRAKC_URL}/api/tuners" | jq -r --arg name "${adapter}" '.[] | select(.name == $name) | .isUsing' 2>/dev/null)"
    [ "${still}" != 'true' ] && return 0
    sleep 0.25
    i=$((i + 1))
  done

  # 5秒待ってもSIGTERMに応じない場合は強制終了
  kill -9 "${pid}" 2>/dev/null || true
}

# 1チャンネルをチューニングしてサービス情報を取得する。
# out_fileに "type<TAB>channel<TAB>name<TAB>sid" 行を追記する
# (CS+EXTRACT_SID=1の場合はサービス単位で複数行、それ以外はチャンネル1行)。
#
# 以前は事前にrecisdb checksignalで信号有無だけ軽く確認してから本チューニ
# ングしていたが廃止した。実測すると無信号判定はchecksignalもrecisdb tune
# も同じ約7秒かかり(同じロック検出処理を通るため)、有信号の場合はFIFO経由
# (下記)で数秒で終わるようになったので、checksignalは成功するチャンネルで
# 二度手間になるだけで得が無かった。
scan_channel() {
  type="$1"
  ch="$2"
  tune_tmpl="$3"
  out_file="$4"
  scan_timeout_secs="$5"

  rec_cmd="$(echo "${tune_tmpl}" | sed -e "s/<channel>/${ch}/")"
  evict_tuner_user "${rec_cmd}"
  echo "[type: ${type}, channel: ${ch}] tuning and scanning services" >&2
  # timeoutはrecisdb本体だけを対象にする(パイプ全体ではなく)。recisdbは
  # 時間指定なしだと自分では終了しないための保険。--kill-after=5はSIGTERM
  # を無視された場合に5秒後SIGKILLで確実に終わらせるため。
  #
  # recisdb→mirakc-aribはパイプではなくFIFO経由にして、recisdbのpidを
  # 個別に扱えるようにしている。mirakc-aribはPAT+SDT+NITが揃った時点
  # (ロック後1秒未満)で終了するが、recisdbは自分では終了しないので、
  # mirakc-aribが終わった時点で即recisdbをkillする。パイプの
  # ままだと$(...)が両方の終了を待ってしまい、成功したチャンネルでも
  # 毎回scan_timeout_secs分待つことになる。
  fifo="${TMPDIR}/scan-${ch}-$$.fifo"
  mkfifo "${fifo}"
  timeout --kill-after=5 "${scan_timeout_secs}" ${rec_cmd} > "${fifo}" 2>/dev/null &
  tune_pid=$!
  json=$(/usr/local/bin/mirakc-arib scan-services < "${fifo}" 2>/dev/null | jq -M -c || printf '')
  kill "${tune_pid}" 2>/dev/null || true
  wait "${tune_pid}" 2>/dev/null || true
  rm -f "${fifo}"
  if [ -z "${json}" ]; then
    echo "[type: ${type}, channel: ${ch}] no service data (or timed out after ${scan_timeout_secs}s), skip" >&2
    return 0
  fi

  if [ "${type}" = 'CS' ] && [ "${EXTRACT_SID}" = '1' ]; then
    n=$(echo "${json}" | jq -M -r 'length')
    i=0
    while [ "${i}" -lt "${n}" ]; do
      service_json=$(echo "${json}" | jq -M -c ".[${i}]")
      sname=$(to_half_width "$(echo "${service_json}" | jq -M -r '.name')")
      sid=$(echo "${service_json}" | jq -M -r '.sid')
      printf '%s\t%s\t%s\t%s\n' "${type}" "${ch}" "${sname}" "${sid}" >> "${out_file}"
      i=$((i + 1))
    done
  elif [ "${type}" = 'CS' ]; then
    sname="${ch}"
    sid=$(echo "${json}" | jq -M -r '.[] | .sid' | jq -M -s . | jq -M -r 'join(",")')
    printf '%s\t%s\t%s\t%s\n' "${type}" "${ch}" "${sname}" "${sid}" >> "${out_file}"
  else
    sname=$(to_half_width "$(echo "${json}" | jq -M -r '.[0] | .name')")
    sid=$(echo "${json}" | jq -M -r '.[] | .sid' | jq -M -s . | jq -M -r 'join(",")')
    printf '%s\t%s\t%s\t%s\n' "${type}" "${ch}" "${sname}" "${sid}" >> "${out_file}"
  fi
}

# sid(4列目)が既に出た行を捨てる(初出のみ残す)
dedup_lines() {
  file="$1"
  seen=''
  while IFS= read -r line; do
    [ -z "${line}" ] && continue
    line_sid=$(printf '%s' "${line}" | cut -f 4)
    dup=0
    for s in ${seen}; do
      if [ "${s}" = "${line_sid}" ]; then
        dup=1
        break
      fi
    done
    if [ "${dup}" = '0' ]; then
      printf '%s\n' "${line}"
      seen="${seen} ${line_sid}"
    fi
  done < "${file}"
}

# 1つの帯域を2チューナーで並列走査し、結果をマージする(必要ならsidで重複排除)
scan_group() {
  type="$1"
  channels="$2"
  tune_a="$3"
  tune_b="$4"
  dedup="$5"
  scan_timeout_secs="$6"

  half_a=$(printf '%s\n' "${channels}" | awk 'NR % 2 == 1')
  half_b=$(printf '%s\n' "${channels}" | awk 'NR % 2 == 0')

  out_a="${TMPDIR}/${type}.a.tsv"
  out_b="${TMPDIR}/${type}.b.tsv"
  : > "${out_a}"
  : > "${out_b}"

  (
    for ch in ${half_a}; do
      scan_channel "${type}" "${ch}" "${tune_a}" "${out_a}" "${scan_timeout_secs}"
    done
  ) &
  pid_a=$!

  (
    for ch in ${half_b}; do
      scan_channel "${type}" "${ch}" "${tune_b}" "${out_b}" "${scan_timeout_secs}"
    done
  ) &
  pid_b=$!

  wait "${pid_a}" "${pid_b}"

  combined="${TMPDIR}/${type}.tsv"
  cat "${out_a}" "${out_b}" > "${combined}"

  if [ "${dedup}" = '1' ]; then
    dedup_lines "${combined}"
  elif [ -s "${combined}" ]; then
    cat "${combined}"
  fi
}

require_tool jq
require_tool recisdb
require_tool timeout
require_tool mirakc-arib
require_tool curl

TMPDIR=$(mktemp -d)
trap 'rm -rf "${TMPDIR}"' EXIT

all_lists=''

# GRはadapter1/3、BS/CSはadapter0/2と物理的に別チューナーなので、GRだけ
# バックグラウンドで並走させる(BS/CSの完了を待たない)。BS/CS同士は同じ
# チューナーを共有するので順番(BS→CS)のまま。
gr_list_file="${TMPDIR}/gr-list.txt"
: > "${gr_list_file}"
gr_pid=''
if [ -n "${RECORD_COMMAND_GR_A}" ]; then
  (
    scan_group 'GR' "${CHANNELS_GR}" \
      "${RECORD_COMMAND_GR_A}" "${RECORD_COMMAND_GR_B}" 1 "${SCAN_TIMEOUT_GR}" \
      > "${gr_list_file}"
  ) &
  gr_pid=$!
fi

bscs_list_file="${TMPDIR}/bscs-list.txt"
: > "${bscs_list_file}"
(
  if [ -n "${RECORD_COMMAND_BS_A}" ]; then
    scan_group 'BS' "${CHANNELS_BS}" \
      "${RECORD_COMMAND_BS_A}" "${RECORD_COMMAND_BS_B}" 1 "${SCAN_TIMEOUT_BS}" \
      >> "${bscs_list_file}"
  fi
  if [ -n "${RECORD_COMMAND_CS_A}" ]; then
    scan_group 'CS' "${CHANNELS_CS}" \
      "${RECORD_COMMAND_CS_A}" "${RECORD_COMMAND_CS_B}" 0 "${SCAN_TIMEOUT_CS}" \
      >> "${bscs_list_file}"
  fi
) &
bscs_pid=$!

[ -n "${gr_pid}" ] && wait "${gr_pid}"
wait "${bscs_pid}"

for f in "${gr_list_file}" "${bscs_list_file}"; do
  if [ -s "${f}" ]; then
    list="$(cat "${f}")"
    all_lists=$(printf '%s\n%s' "${all_lists}" "${list}" | sed '/^$/d')
  fi
done

if [ -n "${all_lists}" ]; then
  entries_file="${TMPDIR}/new-channels.yml"
  echo "${all_lists}" | awk -F "\t" -v "EXTRACT_SID=${EXTRACT_SID}" '
{
  printf("  - name: '\''%s'\''\n", $3);
  printf("    type: '\''%s'\''\n", $1);
  printf("    channel: '\''%s'\''\n", $2);
  if (EXTRACT_SID == "1") {
    printf("    services: [%s]\n", $4);
  }
}' > "${entries_file}"

  # channels:ブロックの中身だけをこの実行結果で丸ごと置き換える(位置は
  # 変えない。collect-logos.shのresource:と違ってファイル末尾に移動しない
  # ので、他のセクションやレイアウトはそのまま)。
  new_config="${TMPDIR}/config.yml.new"
  awk -v entries_file="${entries_file}" '
    /^channels:/ {
      print
      while ((getline line < entries_file) > 0) print line
      in_channels = 1
      next
    }
    in_channels && /^[^[:space:]]/ { in_channels = 0 }
    in_channels { next }
    { print }
  ' "${CONFIG_FILE}" > "${new_config}"
  cat "${new_config}" > "${CONFIG_FILE}"

  echo "rewrote channels: block in ${CONFIG_FILE} with $(echo "${all_lists}" | wc -l) channel(s)" >&2
  echo "restart mirakc to apply: kubectl -n epg rollout restart deployment/mirakc" >&2
else
  echo "no channels found, ${CONFIG_FILE} left unchanged" >&2
fi

exit 0
