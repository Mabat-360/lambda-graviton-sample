#!/usr/bin/env bash
# Per-function Lambda statistics for one time window, from the REPORT lines in CloudWatch Logs.
#
#   bash measure/lambda-report.sh [options] <start> <end> [<log-group> ...]
#
#   <start> <end>   ISO 8601 times (UTC unless an offset is given), e.g. 2030-01-31T16:00:00Z
#   <log-group>     one or more Lambda log groups, or set LOG_GROUPS="group-1 group-2".
#                   There are no default names.
#
# Options (environment variable):
#   --profile NAME            AWS CLI profile (AWS_PROFILE)
#   --region NAME             AWS region (AWS_REGION)
#   --out FILE                where the raw query result goes (OUT, default ./lambda-report.json)
#   --require-substring STR   refuse to run unless every log group name contains STR
#                             (REQUIRE_SUBSTRING), for example "/dev/": a guard against
#                             querying production logs by mistake
#
# Needs bash, Python 3 and the AWS CLI v2 with logs:StartQuery and logs:GetQueryResults.
# Run it a few minutes after the window ends: Logs Insights only sees ingested events.
# The saved result holds log group names without the account ID.
set -euo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }

OUT="${OUT:-./lambda-report.json}"
REQUIRE="${REQUIRE_SUBSTRING:-}"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) export AWS_PROFILE="$2"; shift 2 ;;
    --region) export AWS_REGION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --require-substring) REQUIRE="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    --*) echo "unknown option $1" >&2; usage ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[ "${#ARGS[@]}" -ge 2 ] || usage
START="${ARGS[0]}"; END="${ARGS[1]}"
LOGS=("${ARGS[@]:2}")
# shellcheck disable=SC2206
[ "${#LOGS[@]}" -gt 0 ] || LOGS=(${LOG_GROUPS:-})
[ "${#LOGS[@]}" -gt 0 ] || { echo "no log groups: pass them as arguments or set LOG_GROUPS" >&2; exit 2; }

if [ -n "$REQUIRE" ]; then
  for g in "${LOGS[@]}"; do
    case "$g" in
      *"$REQUIRE"*) ;;
      *) echo "refusing log group $g: its name does not contain \"$REQUIRE\"" >&2; exit 3 ;;
    esac
  done
fi

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3 python; do
    if "$c" -c 'import sys; sys.exit(sys.version_info[0] != 3)' >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
[ -n "$PY" ] || { echo "Python 3 not found (set PYTHON)" >&2; exit 2; }
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8

epoch() {
  "$PY" -c 'import sys, datetime as d
t = d.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
print(int((t if t.tzinfo else t.replace(tzinfo=d.timezone.utc)).timestamp()))' "$1"
}
S=$(epoch "$START"); E=$(epoch "$END")

Q='filter @type = "REPORT"
| parse @message /Init Duration: (?<init>[\d.]+) ms/
| stats count() as n, count(init) as cold, avg(@duration) as avg_ms, pct(@duration,50) as p50_ms, pct(@duration,95) as p95_ms, avg(init) as init_ms, sum(@billedDuration) as billed_ms, max(@memorySize) as mem_b by @log
| sort n desc'

# MSYS_NO_PATHCONV: Git Bash on Windows must not rewrite log group names that start with "/".
QID=$(MSYS_NO_PATHCONV=1 aws logs start-query --log-group-names "${LOGS[@]}" --start-time "$S" --end-time "$E" --query-string "$Q" --query queryId --output text)
ST=Running
for _ in $(seq 1 40); do
  ST=$(aws logs get-query-results --query-id "$QID" --query status --output text)
  [ "$ST" = Complete ] && break
  sleep 3
done
[ "$ST" = Complete ] || { echo "query $QID did not complete (status $ST)" >&2; exit 4; }

aws logs get-query-results --query-id "$QID" --output json | "$PY" -c '
import json, re, sys
d = json.load(sys.stdin)
for row in d["results"]:
    for f in row:
        if f["field"] == "@log":
            f["value"] = re.sub(r"^\d+:", "", f["value"])  # drop the account ID
json.dump(d, open(sys.argv[1], "w", encoding="utf-8"), indent=2)
' "$OUT"

"$PY" - "$OUT" "$START" "$END" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print(f"{sys.argv[2]} .. {sys.argv[3]}  status={d['status']}")
cols = ["n", "cold", "avg_ms", "p50_ms", "p95_ms", "init_ms", "billed_ms", "mem_b"]
rows = [{f["field"]: f["value"] for f in r} for r in d["results"]]
width = max([len(m["@log"]) for m in rows] + [len("log group")]) + 2
print("log group".ljust(width) + "".join(c.rjust(10) for c in cols))
for m in rows:
    vals = []
    for c in cols:
        v = m.get(c, "")
        try:
            v = f"{float(v):.0f}" if c in ("n", "cold", "billed_ms") else (f"{float(v)/1e6:.0f}MB" if c == "mem_b" else f"{float(v):.1f}")
        except ValueError:
            pass
        vals.append(str(v).rjust(10))
    print(m["@log"].ljust(width) + "".join(vals))
PY
