# Build + test image for the Linux helper. Same distro as the real target (Ubuntu 26.04);
# Docker on a Mac runs it as linux/arm64, on a PC as linux/amd64. Nothing in here is arch-specific.
#
#   docker build -t vivarium-linux-helper helper/linux
#   helper/linux/scripts/docker-test.sh      # builds the helper inside the container and runs the test
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        rustc cargo pkg-config libxkbcommon-dev xkb-data libgbm-dev \
        libegl1 libegl-mesa0 libgles2 mesa-utils-bin \
        nodejs \
        gtk-4-examples gtk-3-examples foot weston \
        fonts-dejavu-core adwaita-icon-theme ca-certificates procps time \
    && rm -rf /var/lib/apt/lists/*

# Wayland sockets live in XDG_RUNTIME_DIR; GTK wants it 0700.
ENV XDG_RUNTIME_DIR=/run/user/0 \
    CARGO_HOME=/cargo \
    NO_AT_BRIDGE=1
RUN mkdir -p /run/user/0 && chmod 700 /run/user/0

WORKDIR /src
