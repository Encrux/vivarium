#!/usr/bin/env bash
# Daemon mode + the plugin's real helper client (src/helper.ts), in the Ubuntu container.
#   helper/linux/scripts/test-daemon.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
mkdir -p "$here/test/out"
# bundle the plugin's client (no Obsidian imports in it) for Node
"$root/node_modules/.bin/esbuild" "$root/src/helper.ts" --bundle --platform=node --format=esm --log-level=warning --outfile="$here/test/out/helper-client.mjs"
docker build -q -t vivarium-linux-helper "$here" >/dev/null
docker run --rm \
  -v "$here":/src \
  -v vivarium-cargo:/cargo \
  -v vivarium-target:/src/target \
  --shm-size=512m \
  vivarium-linux-helper bash -lc "cargo build --release --locked 2>&1 | tail -1 && node test/daemon.mjs"
