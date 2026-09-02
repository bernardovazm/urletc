#!/usr/bin/env bash
# Reproducible end-to-end run: create a local Python venv + Playwright, build, boot
# `vite preview`, run the Playwright suite against it, and tear down.
#
# Env knobs:
#   E2E_PORT       preview port (default 5199; 5173 is often taken on dev machines)
#   E2E_BASE       target URL (default http://localhost:$E2E_PORT)
#   E2E_VENV       venv dir (default .venv-e2e, gitignored)
#   E2E_NO_SERVER  =1 to skip build+preview and test an already-running E2E_BASE
#   E2E_WITH_DEPS  =1 to `playwright install --with-deps` (CI; needs root)
#   E2E_NO_HISTORY =1 to skip the slow two-context history replay harness
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-5199}"
BASE="${E2E_BASE:-http://localhost:$PORT}"
VENV="${E2E_VENV:-.venv-e2e}"

# 1. Python venv + Playwright (idempotent).
if [ ! -x "$VENV/bin/python" ]; then
  echo "> creating venv at $VENV"
  python3 -m venv "$VENV"
fi
PY="$VENV/bin/python"
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet -r requirements.txt
if [ "${E2E_WITH_DEPS:-0}" = "1" ]; then
  "$PY" -m playwright install --with-deps chromium
else
  "$PY" -m playwright install chromium
fi

# 2. Build + preview (unless pointed at an already-running server).
SERVER_PID=""
if [ "${E2E_NO_SERVER:-0}" != "1" ]; then
  [ -f dist/index.html ] || npm run build
  echo "> starting preview on :$PORT"
  npm run preview -- --port "$PORT" --strictPort >/tmp/wt-e2e-preview.log 2>&1 &
  SERVER_PID=$!
  trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true' EXIT
fi

# 3. Wait for the server to answer.
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE/"; then break; fi
  sleep 0.5
  if [ "$i" = 60 ]; then echo "preview did not come up at $BASE" >&2; exit 1; fi
done

# 4. Run the suite.
E2E_BASE="$BASE" "$PY" scripts/e2e-console.py

# 5. Two-context history replay. Its own harness because it needs a SECOND browser
#    context and real rendezvous between them, which the single-page suite above is not
#    shaped for. Slower than everything else here, hence the opt-out.
if [ "${E2E_NO_HISTORY:-0}" != "1" ]; then
  E2E_BASE="$BASE" "$PY" scripts/e2e-history.py
fi
