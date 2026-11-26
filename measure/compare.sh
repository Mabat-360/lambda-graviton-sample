#!/usr/bin/env bash
# Compares two time windows of the same Lambda functions: an x86_64 baseline and an arm64 run.
# Prints warm duration per function, billed GB-seconds per 1,000 invocations and the
# estimated duration charge per 1,000,000 invocations.
#
#   bash measure/compare.sh [options] <baseStart> <baseEnd> <afterStart> <afterEnd> [<log-group> ...]
#   bash measure/compare.sh --offline [options]       recompute from results saved earlier
#
#   <...Start> <...End>   ISO 8601 times (UTC unless an offset is given), e.g. 2030-01-31T16:00:00Z
#   <log-group>           one or more Lambda log groups, or set LOG_GROUPS="group-1 group-2".
#                         There are no default names.
#
# Options (environment variable):
#   --price-x86 USD           price per GB-second on x86_64 (PRICE_X86), required
#   --price-arm64 USD         price per GB-second on arm64 (PRICE_ARM64), required
#                             Take both from the AWS Lambda pricing page for your region.
#   --results-dir DIR         where the four raw results are kept (RESULTS_DIR, default ./measure-results)
#   --profile NAME            AWS CLI profile (AWS_PROFILE)
#   --region NAME             AWS region (AWS_REGION)
#   --require-substring STR   refuse to run unless every log group name contains STR
#                             (REQUIRE_SUBSTRING), for example "/dev/": a guard against
#                             querying production logs by mistake
#   --offline                 run no query; read DIR/cmp-{base,after}-{all,warm}.json
#
# Needs bash and Python 3; without --offline also the AWS CLI v2 with logs:StartQuery and
# logs:GetQueryResults. Run it a few minutes after the second window ends: Logs Insights
# only sees ingested events. The saved results hold log group names without the account ID.
set -euo pipefail

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }

DIR="${RESULTS_DIR:-./measure-results}"
REQUIRE="${REQUIRE_SUBSTRING:-}"
PRICE_X86="${PRICE_X86:-}"
PRICE_ARM64="${PRICE_ARM64:-}"
OFFLINE=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --price-x86) PRICE_X86="$2"; shift 2 ;;
    --price-arm64) PRICE_ARM64="$2"; shift 2 ;;
    --results-dir) DIR="$2"; shift 2 ;;
    --profile) export AWS_PROFILE="$2"; shift 2 ;;
    --region) export AWS_REGION="$2"; shift 2 ;;
    --require-substring) REQUIRE="$2"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    -h|--help) usage 0 ;;
    --*) echo "unknown option $1" >&2; usage ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
if [ -z "$PRICE_X86" ] || [ -z "$PRICE_ARM64" ]; then
  echo "set --price-x86 and --price-arm64 (USD per GB-second, from the AWS Lambda pricing page for your region)" >&2
  exit 2
fi

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3 python; do
    if "$c" -c 'import sys; sys.exit(sys.version_info[0] != 3)' >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
[ -n "$PY" ] || { echo "Python 3 not found (set PYTHON)" >&2; exit 2; }
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8

if [ "$OFFLINE" -eq 0 ]; then
  [ "${#ARGS[@]}" -ge 4 ] || usage
  LOGS=("${ARGS[@]:4}")
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

  # All invocations: count, cold starts, billed time and configured memory per function.
  Q='filter @type = "REPORT"
| parse @message /Init Duration: (?<init>[\d.]+) ms/
| fields ispresent(init) as is_cold
| stats sum(is_cold) as cold, count() as n,
        avg(@duration) as avg_all,
        sum(@billedDuration) as billed_ms, max(@memorySize) as mem_b by @log'
  # Warm invocations only: a REPORT line without "Init Duration".
  QW='filter @type = "REPORT" and @message not like /Init Duration/
| stats count() as warm_n, avg(@duration) as warm_avg, pct(@duration,50) as warm_p50, pct(@duration,95) as warm_p95 by @log'

  epoch() {
    "$PY" -c 'import sys, datetime as d
t = d.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
print(int((t if t.tzinfo else t.replace(tzinfo=d.timezone.utc)).timestamp()))' "$1"
  }
  run() { # start end query outfile
    local S E QID ST=Running
    S=$(epoch "$1"); E=$(epoch "$2")
    # MSYS_NO_PATHCONV: Git Bash on Windows must not rewrite log group names that start with "/".
    QID=$(MSYS_NO_PATHCONV=1 aws logs start-query --log-group-names "${LOGS[@]}" --start-time "$S" --end-time "$E" --query-string "$3" --query queryId --output text)
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
' "$4"
  }
  mkdir -p "$DIR"
  run "${ARGS[0]}" "${ARGS[1]}" "$Q"  "$DIR/cmp-base-all.json"
  run "${ARGS[0]}" "${ARGS[1]}" "$QW" "$DIR/cmp-base-warm.json"
  run "${ARGS[2]}" "${ARGS[3]}" "$Q"  "$DIR/cmp-after-all.json"
  run "${ARGS[2]}" "${ARGS[3]}" "$QW" "$DIR/cmp-after-warm.json"
fi

"$PY" - "$DIR" "$PRICE_X86" "$PRICE_ARM64" <<'PY'
import json, os, re, sys

d, price_x86, price_arm = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])

def load(name):
    out = {}
    for r in json.load(open(os.path.join(d, name), encoding="utf-8"))["results"]:
        m = {f["field"]: f["value"] for f in r}
        group = re.sub(r"^\d+:", "", m["@log"])
        out[group] = {k: float(v) for k, v in m.items() if k != "@log"}
    return out

ba, bw, aa, aw = (load(f"cmp-{x}.json") for x in ("base-all", "base-warm", "after-all", "after-warm"))

# Short labels (the last part of the log group name) when they are unique.
groups = sorted(set(ba) | set(bw) | set(aa) | set(aw))
short = {g: g.rstrip("/").rsplit("/", 1)[-1] for g in groups}
label = short if len(set(short.values())) == len(groups) else {g: g for g in groups}
w = max([len(v) for v in label.values()] + [len("function")])

def gb_seconds(row):
    # @memorySize is reported in bytes as MB * 1,000,000; Lambda bills MB / 1024 as GB.
    return row["billed_ms"] / 1000 * (row["mem_b"] / 1e6 / 1024)

tot = {"b_gbs": 0.0, "a_gbs": 0.0, "b_n": 0.0, "a_n": 0.0}
print(f"{'function':{w}} {'warm p50 x86':>12} {'arm64':>8} {'chg':>6} | {'warm p95 x86':>12} {'arm64':>8} | "
      f"{'warm n x86':>10} {'arm64':>6} | {'GB-s/1k x86':>11} {'arm64':>8} | {'cost/1k chg':>11}")
compared = [g for g in sorted(bw, key=lambda k: -ba.get(k, {}).get("n", 0)) if g in aw and g in ba and g in aa]
for g in compared:
    b, a = ba[g], aa[g]
    gb_b, gb_a = gb_seconds(b), gb_seconds(a)
    per_b, per_a = gb_b / b["n"] * 1000, gb_a / a["n"] * 1000
    cost_chg = (per_a * price_arm) / (per_b * price_x86) - 1
    tot["b_gbs"] += gb_b; tot["a_gbs"] += gb_a; tot["b_n"] += b["n"]; tot["a_n"] += a["n"]
    p50_chg = aw[g]["warm_p50"] / bw[g]["warm_p50"] - 1
    print(f"{label[g]:{w}} {bw[g]['warm_p50']:12.1f} {aw[g]['warm_p50']:8.1f} {p50_chg:+6.0%} | "
          f"{bw[g]['warm_p95']:12.1f} {aw[g]['warm_p95']:8.1f} | {bw[g]['warm_n']:10.0f} {aw[g]['warm_n']:6.0f} | "
          f"{per_b:11.2f} {per_a:8.2f} | {cost_chg:+11.0%}")
skipped = [label[g] for g in groups if g not in compared]
if skipped:
    print(f"not in both windows, left out: {', '.join(skipped)}")
if not compared:
    sys.exit("no function has data in both windows")

pb, pa = tot["b_gbs"] / tot["b_n"] * 1000, tot["a_gbs"] / tot["a_n"] * 1000
cb, ca = pb * 1000 * price_x86, pa * 1000 * price_arm
print()
print(f"invocations: x86 {tot['b_n']:.0f}, arm64 {tot['a_n']:.0f}")
print(f"billed GB-s per 1,000 invocations: x86 {pb:.2f} -> arm64 {pa:.2f} ({pa / pb - 1:+.1%})")
print(f"estimated duration charge per 1,000,000 invocations: x86 ${cb:.4f} -> arm64 ${ca:.4f} ({ca / cb - 1:+.1%})")
print(f"  at ${price_x86:.10f} (x86) and ${price_arm:.10f} (arm64) per GB-second; request charges not included")
cold_b = sum(v["cold"] for v in ba.values()); cold_a = sum(v["cold"] for v in aa.values())
print(f"cold starts in window: x86 {cold_b:.0f}, arm64 {cold_a:.0f}")

# The two queries of a window must agree: all - cold = warm. If not, the logs were probably
# still being ingested when the first query ran; run the queries again.
for name, allq, warmq in (("x86", ba, bw), ("arm64", aa, aw)):
    n = sum(v["n"] for v in allq.values()); cold = sum(v["cold"] for v in allq.values())
    warm = sum(v["warm_n"] for v in warmq.values())
    if n - cold != warm:
        print(f"WARNING {name}: {n:.0f} invocations - {cold:.0f} cold = {n - cold:.0f}, but the warm query counted {warm:.0f}; "
              "the two queries saw different log events (ingestion delay?). Run the queries again.")
PY
