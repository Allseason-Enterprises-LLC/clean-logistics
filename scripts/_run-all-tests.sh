#!/usr/bin/env bash
# Runs every scripts/_test-*.ts; prints per-file verdict and PASS/FAIL assertion totals.
cd "$(dirname "$0")/.." || exit 1
set -a; source .env.prod.local; set +a
OUT=${1:-/tmp/cl-tests}; mkdir -p "$OUT"; rm -f "$OUT"/*.log
pass=0; fail=0; failed=""
for f in scripts/_test-*.ts; do
  b=$(basename "$f" .ts)
  if timeout 120 npx tsx "$f" > "$OUT/$b.log" 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); failed="$failed $b"; fi
done
echo "FILES pass=$pass fail=$fail"
echo "FAILED:$failed"
echo "ASSERT PASS=$(cat "$OUT"/*.log | grep -c '^PASS') FAIL=$(cat "$OUT"/*.log | grep -c '^FAIL')"
