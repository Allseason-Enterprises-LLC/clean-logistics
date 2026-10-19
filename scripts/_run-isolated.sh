#!/usr/bin/env bash
# Runs one tsx script with NO real credentials in env (Supabase pointed at a dead port),
# so a mocked test can never reach prod. Usage: scripts/_run-isolated.sh scripts/_test-x.ts
cd "$(dirname "$0")/.." || exit 1
exec env -i PATH="$PATH" HOME="$HOME" \
  SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=x SUPABASE_ANON_KEY=x \
  CIN7_ACCOUNT_ID=acct-test CIN7_API_KEY=key-test \
  timeout 120 npx tsx "$@"
