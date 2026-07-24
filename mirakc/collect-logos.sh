#!/bin/sh
set -eu

export LANG=C.UTF-8

# Collects station logos by tuning channels and reading logo data with
# `mirakc-arib collect-logos`. Meant to run inside the mirakc pod, against
# mirakc's own HTTP API, so it does not fight the running mirakc process for
# tuner access:
#
#   kubectl -n epg exec -it deploy/mirakc -- sh
#   ./collect-logos.sh
#
# Images are written to OUTPUT_DIR (default /var/lib/mirakc/logos, which is
# host-mounted at mirakc/logos/) as "<service-id>.png". The `resource.logos`
# block for all collected logos is then written directly into CONFIG_FILE
# (default /etc/mirakc/config.yml, host-mounted at mirakc/config.yml),
# replacing any previous top-level `resource:` section. mirakc still needs a
# restart to pick up the change:
#
#   kubectl -n epg rollout restart deployment/mirakc
#
# GR and BS/CS are handled differently, because they deliver logos
# differently on the wire:
#
# - GR: each multiplex only carries CDT logo data for its own network, so
#   every GR channel is tuned individually (up to PARALLEL_GR at once).
# - BS/CS: per ARIB TR-B15, all BS/CS station logos ride together on one
#   shared "engineering service" data carousel, regardless of which BS/CS
#   channel you actually tune (this is also how Mirakurun does it: tuning
#   networkId 4 (BS) picks up logos for networkId 4, 6 and 7 (110-degree CS)
#   alike). So by default we don't tune every BS/CS channel -- we only tune
#   BSCS_REPRESENTATIVE_COUNT BS channels (any BS channel carries the whole
#   lineup) for a much longer BSCS_COLLECT_SECONDS, and rely on each logo
#   entry's own service list (or networkId, resolved against the full
#   service list, not just the tuned channel's own services) to file it under
#   the right service id. This is skipped entirely once every BS/CS service
#   already has a logo, and CHANNELS explicitly overrides it (see below).
#
# A full run can still take a while: mirakc-arib's own guidance is that not
# every logo is sent every cycle, and BS/CS logos in particular can be much
# less frequent than that -- sometimes not sent at all for a while. The
# script skips channels/services whose logo file is still "fresh" (see
# REFRESH_DAYS below), so it is safe to re-run / resume across multiple
# sessions, which is also how `cronjob.yaml`'s scheduled retries make
# progress over time.
#
# A station can change its logo, so an already-collected file isn't skipped
# forever: once its mtime is older than REFRESH_DAYS, it's treated as missing
# again and gets re-collected (overwriting the file, which also resets its
# mtime -- no separate bookkeeping needed). This mirrors Mirakurun's
# `logoDataInterval` (7 days by default there too), which re-checks a
# network's logos only after that many days rather than continuously.
#
# Env vars:
#   OUTPUT_DIR                where to write logo images (default: /var/lib/mirakc/logos)
#   CONFIG_FILE                mirakc config to rewrite with resource.logos (default: /etc/mirakc/config.yml)
#   COLLECT_SECONDS            seconds to listen per GR channel (default: 600)
#   BSCS_COLLECT_SECONDS       seconds to listen per BS/CS representative channel (default: 1500)
#   BSCS_REPRESENTATIVE_COUNT  how many BS channels to tune by default for the whole BS/CS lineup (default: 2)
#   REFRESH_DAYS               re-collect a logo whose file is older than this many days (default: 7)
#   CHANNELS                   space-separated "TYPE/CHANNEL" or bare "TYPE" list to limit the run,
#                              e.g. "GR/27 BS/BS15_1" or "GR". Setting this disables the BS/CS
#                              representative-channel shortcut: exactly what you list gets tuned.
#   FORCE                      set to 1 to re-collect channels/services regardless of freshness
#   MIRAKC_URL                 base URL of mirakc's HTTP API (default: http://localhost:40772)
#   PARALLEL_GR                concurrent GR channels to collect at once (default: 2)
#   PARALLEL_BSCS              concurrent BS/CS channels to collect at once (default: 2)
#   STREAM_PRIORITY            X-Mirakurun-Priority sent with each stream request (default: -2).
#                              mirakc's own EPG jobs (scan-services/sync-clocks/update-schedules)
#                              request tuners at priority -1, and a tuner can only be grabbed away
#                              from its current user by a strictly higher priority. Keeping this
#                              below -1 means one of those jobs can always preempt a logo-collection
#                              stream if it needs the same tuner, so program-info collection never
#                              gets starved by this script (a preempted stream just ends early;
#                              process_channel already treats a short/empty capture as normal and
#                              retries on a later run).

readonly OUTPUT_DIR="${OUTPUT_DIR:-/var/lib/mirakc/logos}"
readonly CONFIG_FILE="${CONFIG_FILE:-/etc/mirakc/config.yml}"
readonly COLLECT_SECONDS="${COLLECT_SECONDS:-600}"
readonly BSCS_COLLECT_SECONDS="${BSCS_COLLECT_SECONDS:-1500}"
readonly BSCS_REPRESENTATIVE_COUNT="${BSCS_REPRESENTATIVE_COUNT:-2}"
readonly REFRESH_DAYS="${REFRESH_DAYS:-7}"
readonly FORCE="${FORCE:-0}"
readonly MIRAKC_URL="${MIRAKC_URL:-http://localhost:40772}"
readonly PARALLEL_GR="${PARALLEL_GR:-2}"
readonly PARALLEL_BSCS="${PARALLEL_BSCS:-2}"
readonly STREAM_PRIORITY="${STREAM_PRIORITY:--2}"
readonly WORKDIR="$(mktemp -d)"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "require $1" >&2
    exit 1
  fi
}

require_tool jq
require_tool curl
require_tool timeout
require_tool base64
require_tool mirakc-arib
require_tool stat

mkdir -p "${OUTPUT_DIR}"
trap 'rm -rf "${WORKDIR}"' EXIT

readonly ALL_SERVICES_FILE="${WORKDIR}/services.jsonl"
curl -sf "${MIRAKC_URL}/api/services" | jq -c '.[]' > "${ALL_SERVICES_FILE}"

# A service's logo counts as fresh if its file exists and isn't older than
# REFRESH_DAYS. Overwriting the file on a later re-collect also refreshes its
# mtime, so no separate "last checked" bookkeeping is needed.
logo_is_fresh() {
  file="${OUTPUT_DIR}/$1.png"
  [ -f "${file}" ] || return 1
  age=$(( $(date +%s) - $(stat -c %Y "${file}") ))
  [ "${age}" -lt "$(( REFRESH_DAYS * 86400 ))" ]
}

# Collects logos for a single channel. $1 is the channel JSON object, $2 is a
# scratch directory private to the caller (so concurrent callers don't
# clobber each other's temp files), $3 is how long to listen, and $4 is
# whether to skip this channel when its own services already all have a logo
# file (pass 0 for the BS/CS representative channels, which get tuned
# regardless of their own status since they're just a relay for the whole
# BS/CS lineup -- see the header comment).
process_channel() {
  channel_json="$1"
  workdir="$2"
  collect_seconds="$3"
  skip_if_collected="$4"

  type="$(echo "${channel_json}" | jq -r '.type')"
  ch="$(echo "${channel_json}" | jq -r '.channel')"
  service_ids="$(echo "${channel_json}" | jq -r '.services[].id')"

  if [ -z "${service_ids}" ]; then
    echo "[${type}/${ch}] no services, skipping" >&2
    return 0
  fi

  if [ "${skip_if_collected}" = '1' ] && [ "${FORCE}" != '1' ]; then
    missing=0
    for id in ${service_ids}; do
      logo_is_fresh "${id}" || missing=1
    done
    if [ "${missing}" = '0' ]; then
      echo "[${type}/${ch}] already collected, skipping" >&2
      return 0
    fi
  fi

  echo "[${type}/${ch}] collecting for ${collect_seconds}s..." >&2

  raw="${workdir}/logos.jsonl"
  : > "${raw}"

  set +e
  curl -s -G "${MIRAKC_URL}/api/channels/${type}/${ch}/stream" --data-urlencode 'decode=0' \
      -H "X-Mirakurun-Priority: ${STREAM_PRIORITY}" \
      --max-time "$((collect_seconds + 30))" \
    | timeout "${collect_seconds}s" mirakc-arib collect-logos >> "${raw}" 2>/dev/null
  set -e

  if [ ! -s "${raw}" ]; then
    echo "[${type}/${ch}] no logo data captured" >&2
    return 0
  fi

  while IFS= read -r line; do
    [ -n "${line}" ] || continue

    ltype="$(echo "${line}" | jq -r '.type')"
    lnid="$(echo "${line}" | jq -r '.nid')"
    data="$(echo "${line}" | jq -r '.data')"
    has_services="$(echo "${line}" | jq -r 'has("services")')"

    if [ "${has_services}" = 'true' ]; then
      target_ids="$(echo "${line}" | jq -r '.services[] | (.nid * 100000 + .sid)')"
    else
      # No explicit service list on this entry: resolve it against the full
      # service list (not just the tuned channel's own services), since a
      # BS/CS representative channel's stream can carry logos belonging to
      # other networks entirely.
      target_ids="$(jq -r --argjson nid "${lnid}" 'select(.networkId == $nid) | .id' "${ALL_SERVICES_FILE}")"
    fi

    for id in ${target_ids}; do
      best_file="${workdir}/best-${id}"
      cur_best=-1
      [ -f "${best_file}" ] && cur_best="$(cat "${best_file}")"

      if [ "${ltype}" -gt "${cur_best}" ]; then
        echo "${ltype}" > "${best_file}"
        tmp_png="${OUTPUT_DIR}/${id}.png.tmp.$$"
        printf '%s' "${data}" | cut -d ',' -f 2 | base64 -d > "${tmp_png}"
        mv "${tmp_png}" "${OUTPUT_DIR}/${id}.png"
      fi
    done
  done < "${raw}"

  rm -f "${workdir}"/best-*
}

# Splits group_file's channels round-robin across `parallel` workers, each
# running process_channel sequentially in the background, then waits for all
# of them. Channels within one group share a tuner pool, so `parallel` should
# not exceed the number of tuners available for that group. $4/$5 are passed
# straight through to process_channel as collect_seconds/skip_if_collected.
run_group() {
  group_file="$1"
  parallel="$2"
  prefix="$3"
  collect_seconds="$4"
  skip_if_collected="$5"

  [ -s "${group_file}" ] || return 0

  i=0
  while [ "${i}" -lt "${parallel}" ]; do
    : > "${WORKDIR}/${prefix}-worker-${i}.jsonl"
    i=$((i + 1))
  done

  i=0
  while IFS= read -r channel_json; do
    echo "${channel_json}" >> "${WORKDIR}/${prefix}-worker-$((i % parallel)).jsonl"
    i=$((i + 1))
  done < "${group_file}"

  i=0
  while [ "${i}" -lt "${parallel}" ]; do
    worker_file="${WORKDIR}/${prefix}-worker-${i}.jsonl"
    workerdir="${WORKDIR}/${prefix}-${i}"
    mkdir -p "${workerdir}"
    (
      while IFS= read -r channel_json; do
        process_channel "${channel_json}" "${workerdir}" "${collect_seconds}" "${skip_if_collected}"
      done < "${worker_file}"
    ) &
    i=$((i + 1))
  done
  wait
}

all_channels="$(curl -sf "${MIRAKC_URL}/api/channels" | jq -c '.[]')"

channels_filtered=0
if [ -n "${CHANNELS:-}" ]; then
  channels_filtered=1
  filtered=''
  for want in ${CHANNELS}; do
    case "${want}" in
      */*)
        want_type="${want%%/*}"
        want_ch="${want#*/}"
        line="$(echo "${all_channels}" | jq -c --arg t "${want_type}" --arg c "${want_ch}" 'select(.type == $t and .channel == $c)')"
        if [ -z "${line}" ]; then
          echo "warning: channel ${want} not found in /api/channels, skipping" >&2
          continue
        fi
        ;;
      *)
        # No "/" in the entry: treat it as a bare type (e.g. "GR") matching
        # every channel of that type.
        line="$(echo "${all_channels}" | jq -c --arg t "${want}" 'select(.type == $t)')"
        if [ -z "${line}" ]; then
          echo "warning: no channels of type ${want} found in /api/channels, skipping" >&2
          continue
        fi
        ;;
    esac
    filtered="$(printf '%s\n%s' "${filtered}" "${line}" | sed '/^$/d')"
  done
  all_channels="${filtered}"
fi

channels_file="${WORKDIR}/channels.jsonl"
echo "${all_channels}" | jq -c 'select(. != null)' > "${channels_file}"

gr_file="${WORKDIR}/queue-gr.jsonl"
bscs_file="${WORKDIR}/queue-bscs.jsonl"
: > "${gr_file}"
: > "${bscs_file}"

while IFS= read -r channel_json; do
  type="$(echo "${channel_json}" | jq -r '.type')"
  if [ "${type}" = 'GR' ]; then
    echo "${channel_json}" >> "${gr_file}"
  else
    echo "${channel_json}" >> "${bscs_file}"
  fi
done < "${channels_file}"

bscs_skip_if_collected=1
if [ "${channels_filtered}" = '0' ]; then
  bscs_any_missing=0
  while IFS= read -r channel_json; do
    service_ids="$(echo "${channel_json}" | jq -r '.services[].id')"
    for id in ${service_ids}; do
      logo_is_fresh "${id}" || bscs_any_missing=1
    done
  done < "${bscs_file}"

  if [ "${bscs_any_missing}" = '0' ] && [ "${FORCE}" != '1' ]; then
    echo "all BS/CS logos already collected, skipping" >&2
    : > "${bscs_file}"
  else
    representative_file="${WORKDIR}/queue-bscs-representative.jsonl"
    jq -c 'select(.type == "BS")' "${bscs_file}" | head -n "${BSCS_REPRESENTATIVE_COUNT}" > "${representative_file}"
    bscs_file="${representative_file}"
    bscs_skip_if_collected=0
  fi
fi

run_group "${gr_file}" "${PARALLEL_GR}" gr "${COLLECT_SECONDS}" 1 &
run_group "${bscs_file}" "${PARALLEL_BSCS}" bscs "${BSCS_COLLECT_SECONDS}" "${bscs_skip_if_collected}" &
wait

logo_files="$(find "${OUTPUT_DIR}" -maxdepth 1 -name '*.png' | sort)"
if [ -n "${logo_files}" ]; then
  block_file="${WORKDIR}/resource-logos.yml"
  {
    echo 'resource:'
    echo '  logos:'
    for f in ${logo_files}; do
      id="$(basename "${f}" .png)"
      printf '    - service-id: %s\n      image: %s\n' "${id}" "${f}"
    done
  } > "${block_file}"

  # Drop any existing top-level `resource:` block from CONFIG_FILE, then
  # append the freshly generated one. Top-level keys in this config are
  # always at column 0, so that's what marks the end of the old block.
  new_config="${WORKDIR}/config.yml.new"
  awk -v block_file="${block_file}" '
    /^resource:/ { in_resource = 1; next }
    in_resource && /^[^[:space:]]/ { in_resource = 0 }
    in_resource { next }
    { print }
    END {
      while ((getline line < block_file) > 0) print line
    }
  ' "${CONFIG_FILE}" > "${new_config}"
  cat "${new_config}" > "${CONFIG_FILE}"

  echo "wrote $(echo "${logo_files}" | wc -l) logo(s) into ${CONFIG_FILE}" >&2
  echo "restart mirakc to apply: kubectl -n epg rollout restart deployment/mirakc" >&2
else
  echo "no logos collected" >&2
fi
