#!/bin/sh
set -eu

export LANG=C.UTF-8

# Wrapper around collect-logos.sh meant to run unattended from a k8s CronJob
# (see ../cronjob.yaml), not from an interactive `kubectl exec`. Runs in its
# own short-lived pod (using the same epg-mirakc image, so mirakc-arib/jq/curl
# are already there), talks to mirakc and epgstation over the cluster network,
# and shares config.yml / the logos dir with the mirakc pod via the same
# hostPath mounts.
#
# Before collecting, it checks epgstation for an in-progress recording or one
# starting within LOOKAHEAD_MINUTES, and skips this run entirely if so, to
# leave tuners free for actual recordings. It also skips if mirakc's own EPG
# collection jobs (scan-services / sync-clocks / update-schedules, see
# ../mirakc/config.yml's `jobs:` section) are currently occupying a tuner --
# collect-logos.sh tunes channels through mirakc's own HTTP API too, so
# running alongside those jobs would just contend with them for the same
# small tuner pool and risk starving whichever program-info scan is
# in-flight. It does not re-check mid-run: if a recording gets reserved (or an
# EPG job starts) after collection has already started, mirakc's own tuner
# allocation and collect-logos.sh's existing "no tuner available" handling
# are the safety net (that channel just fails to collect this time and gets
# retried on a later run).
#
# The overall run is capped at MAX_RUNTIME_SECONDS via `timeout` so a single
# invocation can't run past the next scheduled trigger; hitting that cap is
# treated as a normal, successful exit (it just picks up where it left off
# next time, since collect-logos.sh skips channels it already collected).
#
# If CONFIG_FILE actually changed (new logos were merged in), this restarts
# the mirakc Deployment via the k8s API (using the collect-logos
# ServiceAccount's token, see ../cronjob.yaml for the RBAC) so the new
# resource.logos takes effect -- but only after re-checking that no recording
# is in progress at that point, since a full collection pass can take a while
# and a recording may have started in the meantime. If one has, the restart
# is skipped for this cycle; config.yml is already updated on disk, so the
# next cycle (or a manual rollout restart) will pick it up.
#
# Env vars (in addition to collect-logos.sh's own):
#   EPGSTATION_URL      base URL of epgstation's HTTP API (default: http://epgstation.epg.svc.cluster.local:8888)
#   MIRAKC_URL          base URL of mirakc's HTTP API, also used here to check for an in-progress EPG job (default: http://mirakc.epg.svc.cluster.local:40772)
#   LOOKAHEAD_MINUTES   skip this run if a recording starts within this many minutes (default: 30)
#   MAX_RUNTIME_SECONDS overall wall-clock budget for this run (default: 1700)
#   K8S_NAMESPACE       namespace of the mirakc Deployment (default: epg)
#   MIRAKC_DEPLOYMENT   name of the mirakc Deployment to restart (default: mirakc)

readonly EPGSTATION_URL="${EPGSTATION_URL:-http://epgstation.epg.svc.cluster.local:8888}"
readonly MIRAKC_URL="${MIRAKC_URL:-http://mirakc.epg.svc.cluster.local:40772}"
readonly LOOKAHEAD_MINUTES="${LOOKAHEAD_MINUTES:-30}"
readonly MAX_RUNTIME_SECONDS="${MAX_RUNTIME_SECONDS:-1700}"
readonly K8S_NAMESPACE="${K8S_NAMESPACE:-epg}"
readonly MIRAKC_DEPLOYMENT="${MIRAKC_DEPLOYMENT:-mirakc}"
readonly CONFIG_FILE="${CONFIG_FILE:-/etc/mirakc/config.yml}"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "require $1" >&2
    exit 1
  fi
}

require_tool curl
require_tool jq
require_tool timeout
require_tool sha256sum

recording_in_progress() {
  count="$(curl -sf "${EPGSTATION_URL}/api/recording?isHalfWidth=false&limit=1" \
    | jq '[.records[] | select(.isRecording == true)] | length')"
  [ "${count}" != '0' ]
}

# mirakc runs its own EPG collection jobs (see ../mirakc/config.yml's `jobs:`
# section) as ordinary tuner users, exposed via /api/tuners with a user id of
# "job:epg.<name>" (e.g. "job:epg.update-schedules"). Treat any of those as
# "program info is still being fetched" and stay off the tuners until they're
# done.
epg_job_in_progress() {
  curl -sf "${MIRAKC_URL}/api/tuners" \
    | jq -e '[.[] | .users[]? | select(.id | startswith("job:epg."))] | length > 0' >/dev/null
}

restart_mirakc() {
  token="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"
  restarted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  curl -sf -X PATCH \
    --cacert /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/strategic-merge-patch+json' \
    -d "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"kubectl.kubernetes.io/restartedAt\":\"${restarted_at}\"}}}}}" \
    "https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}/apis/apps/v1/namespaces/${K8S_NAMESPACE}/deployments/${MIRAKC_DEPLOYMENT}" \
    >/dev/null
}

if recording_in_progress; then
  echo "a recording is in progress, skipping this run" >&2
  exit 0
fi

if epg_job_in_progress; then
  echo "mirakc is currently running its own EPG collection job, skipping this run" >&2
  exit 0
fi

now_ms=$(( $(date +%s) * 1000 ))
horizon_ms=$(( now_ms + LOOKAHEAD_MINUTES * 60 * 1000 ))

soon_count="$(curl -sf "${EPGSTATION_URL}/api/reserves?isHalfWidth=false&type=normal&limit=100" \
  | jq --argjson now "${now_ms}" --argjson horizon "${horizon_ms}" \
      '[.reserves[] | select(.startAt >= $now and .startAt <= $horizon)] | length')"
if [ "${soon_count}" != '0' ]; then
  echo "a recording starts within ${LOOKAHEAD_MINUTES} minutes, skipping this run" >&2
  exit 0
fi

config_before="$(sha256sum "${CONFIG_FILE}" | awk '{print $1}')"

echo "no recording conflict, starting collect-logos.sh (budget: ${MAX_RUNTIME_SECONDS}s)" >&2

set +e
timeout "${MAX_RUNTIME_SECONDS}" /collect-logos.sh
rc=$?
set -e

if [ "${rc}" -ne 0 ] && [ "${rc}" -ne 124 ]; then
  exit "${rc}"
fi
if [ "${rc}" -eq 124 ]; then
  echo "hit the ${MAX_RUNTIME_SECONDS}s time budget, stopping collection for this run" >&2
fi

config_after="$(sha256sum "${CONFIG_FILE}" | awk '{print $1}')"

if [ "${config_before}" = "${config_after}" ]; then
  echo "config.yml unchanged, nothing to restart" >&2
  exit 0
fi

if recording_in_progress; then
  echo "config.yml changed but a recording started during collection; leaving mirakc as-is, new logos will apply on a later restart" >&2
  exit 0
fi

if epg_job_in_progress; then
  echo "config.yml changed but mirakc's own EPG collection job started during collection; leaving mirakc as-is, new logos will apply on a later restart" >&2
  exit 0
fi

echo "config.yml changed, restarting mirakc to apply new logos" >&2
restart_mirakc
