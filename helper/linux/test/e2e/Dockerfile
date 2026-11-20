# End-to-end: a Linux Obsidian with the plugin, in Xvfb, driven over CDP (test/e2e/run.mjs).
# Built on top of the helper's image (same distro, has the helper's build deps and foot).
FROM vivarium-linux-helper
ARG OBSIDIAN=1.15.1
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb xauth curl libnss3 libasound2t64 libgtk-3-0t64 libxss1 libxtst6 libsecret-1-0 libdrm2 libgbm1 \
    && rm -rf /var/lib/apt/lists/*
RUN arch=$(dpkg --print-architecture); suffix=$([ "$arch" = arm64 ] && echo "-arm64" || echo ""); \
    curl -fsSL "https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN}/obsidian-${OBSIDIAN}${suffix}.tar.gz" \
      | tar -xz -C /opt && mv /opt/obsidian-${OBSIDIAN}* /opt/obsidian
