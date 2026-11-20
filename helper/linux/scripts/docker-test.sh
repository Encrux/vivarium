#!/usr/bin/env bash
# Build the helper inside the Ubuntu container and run the Node test harness there.
#   helper/linux/scripts/docker-test.sh            build + unit tests + harness
#   helper/linux/scripts/docker-test.sh build      build only
#   helper/linux/scripts/docker-test.sh shell      interactive shell in the container
# Cargo's registry and the target dir live in named volumes so rebuilds are incremental.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
image=vivarium-linux-helper
docker build -q -t "$image" "$here" >/dev/null

run() {
  docker run --rm ${TTY:-} \
    -v "$here":/src \
    -v vivarium-cargo:/cargo \
    -v vivarium-target:/src/target \
    --shm-size=512m \
    "$image" bash -lc "$1"
}

case "${1:-test}" in
  build) run "cargo build --release --locked" ;;
  shell) TTY=-it run "bash" ;;
  test)
    run "cargo build --release --locked && cargo test --release --locked -q && node test/harness.mjs ${HARNESS_ARGS:-}"
    ;;
  *) echo "usage: $0 [build|test|shell]" >&2; exit 2 ;;
esac
