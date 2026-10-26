#!/usr/bin/env bash
# Runs the webviews/ and web/ bun suites on the Linux VM: bun's file-parallel runner over many
# workers, several whole repeats, then one receipt and an MQ-flakes list (p15-oracle task 214).
#
#   scripts/cmux-next/linux/webviews-tests.sh [--package webviews|web|all] [--repeats N]
#       [--jobs N] [--timeout-ms N] [--run-timeout SECONDS] [--out DIR] [--receipt FILE]
#       [--flaky-out FILE] [--no-install] [--no-bundles] [-- EXTRA_BUN_TEST_ARGS...]
#
# webviews first gets its built bundles (scripts/ci/ensure-web-bundles.sh, as
# scripts/ci/run-webviews-tests.sh does; the bundle tests read them; cache under
# CMUX_CI_CACHE_DIR, default ~/.cache/cmux-ci). Each package gets `bun install --frozen-lockfile`,
# then the same command --repeats times (3):
#   webviews: bun test --parallel=JOBS --timeout MS --reporter=junit ... ./FILES
#   web:      bash scripts/run-tests.sh <same arguments>   (web's runner adds --isolate and its
#             Bun version floor; bunfig.toml's preload applies to both)
# FILES are the package's tracked files that match bun's default test names, so every repeat
# and the receipt cover one fixed list for the checkout's sha.
#
# bun's --parallel spreads the files over JOBS worker processes (300 by default), each file in
# its own global, like Chromium's test launcher runs batches in child processes
# (base/test/launcher/test_launcher.cc). The repeats are whole runs, as the launcher's
# --gtest_repeat; a test that passes in one and fails in another is flaky
# (bun_tests_receipt.py). Retries stay off so a flake shows instead of being absorbed.
#
# Counts come from bun's own reporters (junit totals and the console summary). Outputs go
# outside the checkout, under --out (default /tmp/oracle/webviews-tests/SHA12): per package and
# repeat run-N.xml, run-N.log and run-N.meta, plus receipt.json and flaky.jsonl. Exit 0 when
# every repeat completed and no test failed in all of them; flaky tests do not fail the run.
set -euo pipefail

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }

choice=all repeats=3 jobs=300 timeout_ms=30000 run_timeout=1800 install=1 bundles=1
out="" receipt="" flaky_out=""
extra=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --package) choice="$2"; shift 2 ;;
    --repeats) repeats="$2"; shift 2 ;;
    --jobs) jobs="$2"; shift 2 ;;
    --timeout-ms) timeout_ms="$2"; shift 2 ;;
    --run-timeout) run_timeout="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --receipt) receipt="$2"; shift 2 ;;
    --flaky-out) flaky_out="$2"; shift 2 ;;
    --no-install) install=0; shift ;;
    --no-bundles) bundles=0; shift ;;
    --) shift; extra=("$@"); break ;;
    -h | --help) usage; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done
for number in "$repeats" "$jobs" "$timeout_ms" "$run_timeout"; do
  [[ "$number" =~ ^[1-9][0-9]*$ ]] || { echo "error: $number is not a positive integer" >&2; exit 2; }
done
case "$choice" in
  all) packages=(webviews web) ;;
  webviews | web) packages=("$choice") ;;
  *) echo "error: --package is webviews, web or all" >&2; exit 2 ;;
esac
for tool in bun python3 timeout git; do
  command -v "$tool" > /dev/null || { echo "error: $tool is not on PATH" >&2; exit 2; }
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$here" rev-parse --show-toplevel)"
sha="$(git -C "$root" rev-parse HEAD)"
dirty=()
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then dirty=(--dirty); fi
out="${out:-/tmp/oracle/webviews-tests/${sha:0:12}}"
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
case "$out/" in
  "$root"/*) echo "error: --out $out is inside the checkout; outputs go outside it" >&2; exit 2 ;;
esac
receipt="${receipt:-$out/receipt.json}"
flaky_out="${flaky_out:-$out/flaky.jsonl}"
bun_version="$(bun --version)"
export CMUX_WEB_TEST_TIMEOUT_MS="$timeout_ms"

if [ "$bundles" = 1 ] && [ "${packages[0]}" = webviews ]; then
  echo "== webviews: scripts/ci/ensure-web-bundles.sh"
  mkdir -p "$out/webviews-bundles"
  (cd "$root" && CMUX_CI_CACHE_DIR="${CMUX_CI_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/cmux-ci}" \
    bash scripts/ci/ensure-web-bundles.sh) > "$out/webviews-bundles/build.log" 2>&1 || {
    tail -n 20 "$out/webviews-bundles/build.log" >&2
    echo "error: the web bundle build failed (log: $out/webviews-bundles/build.log)" >&2
    exit 1
  }
fi

package_args=()
for package in "${packages[@]}"; do
  dir="$out/$package"
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$root/$package"
  if [ "$install" = 1 ]; then
    echo "== $package: bun install --frozen-lockfile"
    bun install --frozen-lockfile > "$dir/install.log" 2>&1 || {
      tail -n 20 "$dir/install.log" >&2
      echo "error: bun install failed in $package (log: $dir/install.log)" >&2
      exit 1
    }
  fi
  # bun's default test names, minus dot directories and node_modules, as its discovery skips them.
  git ls-files -z -- . |
    grep -zE '(\.test|_test|\.spec|_spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$' |
    grep -zvE '(^|/)(\.[^/]+|node_modules)/' |
    sed -z 's|^|./|' > "$dir/files"
  mapfile -d '' -t files < "$dir/files"
  if [ "${#files[@]}" -eq 0 ]; then
    echo "error: no tracked test files in $package" >&2
    exit 1
  fi
  case "$package" in
    webviews) runner=(bun test) ;;
    web) runner=(bash scripts/run-tests.sh) ;;
  esac
  printf '%q ' "${runner[@]}" "--parallel=$jobs" --timeout "$timeout_ms" --reporter=junit \
    "--reporter-outfile=$dir/run-N.xml" "${extra[@]}" > "$dir/command"
  echo "<${#files[@]} files>" >> "$dir/command"
  for repeat in $(seq 1 "$repeats"); do
    echo "== $package: repeat $repeat/$repeats, ${#files[@]} files over $jobs workers"
    status=0
    SECONDS=0
    timeout -k 10 "$run_timeout" "${runner[@]}" "--parallel=$jobs" --timeout "$timeout_ms" \
      --reporter=junit "--reporter-outfile=$dir/run-$repeat.xml" "${extra[@]}" "${files[@]}" \
      > "$dir/run-$repeat.log" 2>&1 < /dev/null || status=$?
    echo "$status $SECONDS" > "$dir/run-$repeat.meta"
    tail -n 7 "$dir/run-$repeat.log" | sed 's/^/   /'
  done
  package_args+=(--package "$package=$dir")
done

python3 "$here/bun_tests_receipt.py" --receipt "$receipt" --flaky-out "$flaky_out" --sha "$sha" \
  "${dirty[@]}" --jobs "$jobs" --repeats "$repeats" --timeout-ms "$timeout_ms" \
  --bun-version "$bun_version" "${package_args[@]}"
