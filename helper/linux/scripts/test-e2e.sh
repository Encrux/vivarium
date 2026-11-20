#!/usr/bin/env bash
# End-to-end: Linux Obsidian + this plugin + the helper daemon + foot, in Docker (Xvfb, software GL).
#   helper/linux/scripts/test-e2e.sh          (results + screenshots in helper/linux/test/out/e2e)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
(cd "$root" && npm run build >/dev/null)
docker build -q -t vivarium-linux-helper "$here" >/dev/null
docker build -q -t vivarium-linux-e2e "$here/test/e2e" >/dev/null
docker run --rm \
  -v "$here":/src \
  -v "$root/dev-vault/.obsidian/plugins/vivarium":/plugin:ro \
  -v vivarium-cargo:/cargo \
  -v vivarium-target:/src/target \
  --shm-size=1g \
  -e E2E_VERBOSE="${E2E_VERBOSE:-}" \
  vivarium-linux-e2e bash -lc "cargo build --release --locked 2>&1 | tail -1 && node test/e2e/run.mjs"
