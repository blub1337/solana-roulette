#!/bin/sh
# Preview launcher.
#
# One public origin: the API process owns the public port, answers /api/*, and
# proxies everything else to the Next.js dev server on an internal port.
#
# Order matters. The preview picks the first port that starts listening, so the
# API must bind first — otherwise the port goes to Next alone and /api/* is
# unreachable from the browser.
set -e
cd "$(dirname "$0")/.."

PORT_PUBLIC="${PORT:-3000}"
PORT_UI="${UI_INTERNAL_PORT:-3001}"

if [ "$PORT_UI" = "$PORT_PUBLIC" ]; then
  PORT_UI=$((PORT_UI + 1))
fi

# Clear stale processes from a previous run so both ports are free.
pkill -f "tsx.*src/server" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
sleep 1

# A production `next build` (e.g. from a hosting-style verification run) leaves
# BUILD_ID and prod manifests inside apps/web/.next. Those artifacts are
# incompatible with `next dev`: the dev server serves HTML from memory but
# 404s its compiled CSS/JS assets — the page renders unstyled. Remove any
# stale production build so the dev server rebuilds its own cache.
if [ -f apps/web/.next/BUILD_ID ]; then
  rm -rf apps/web/.next
  echo "preview: removed stale production apps/web/.next (dev server needs its own cache)"
fi

echo "preview: public 0.0.0.0:$PORT_PUBLIC (api + ui proxy), ui internal :$PORT_UI"

# 1. Public port first: API routes plus a reverse proxy to the UI.
PORT="$PORT_PUBLIC" \
PREVIEW_UI_URL="http://127.0.0.1:$PORT_UI" \
  npm run dev:api &

# 2. UI on the internal port. Its /api/* rewrite points at the API so the app
#    is fully functional whichever of the two ports the preview settles on.
API_INTERNAL_URL="http://127.0.0.1:$PORT_PUBLIC" \
PORT="$PORT_UI" npm run dev:web &

# Readiness gate: the API owns the public port, so it alone decides whether the
# preview is up. The UI compiles in the background (the proxy answers with a
# "starting" page until it is ready), so a slow Next.js compile can never make
# the whole preview fail.
i=0
while [ "$i" -lt 120 ]; do
  if curl -sf "http://127.0.0.1:$PORT_PUBLIC/api/health" >/dev/null 2>&1; then
    echo "preview: ready (api :$PORT_PUBLIC, ui :$PORT_UI starting in background)"
    break
  fi
  sleep 0.5
  i=$((i + 1))
done

if ! curl -sf "http://127.0.0.1:$PORT_PUBLIC/api/health" >/dev/null 2>&1; then
  echo "API failed to become healthy on :$PORT_PUBLIC" >&2
  exit 1
fi

# Warm the UI so the first real request is fast (best effort, never fatal).
( i=0; while [ "$i" -lt 120 ]; do
    curl -sf "http://127.0.0.1:$PORT_UI/" >/dev/null 2>&1 && { echo "preview: ui ready (:$PORT_UI)"; break; }
    sleep 0.5
    i=$((i + 1))
  done ) &

# Keep both children alive for the lifetime of the preview.
wait
