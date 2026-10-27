# syntax=docker/dockerfile:1
#
# OMO × OpenCode V2 build/test base image.
# Everything (deps, build, tests) runs inside this image; the host repo stays dependency-free.
#
# Pin the runtime on purpose: the monorepo CI uses bun 1.4.4 (.github/workflows/*.yml).
FROM oven/bun:1.4.4

# V2 CLI. Its bin exposes both `opencode` (V1-compatible) and `opencode2` (V2).
ARG OPENCODE_CLI_VERSION=2.1.4
# registry.npmjs.org is slow from some networks; pass a mirror to build
ARG BUN_REGISTRY=https://registry.npmjs.org

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/root \
    BUN_INSTALL_CACHE_DIR=/root/.cache/bun \
    DO_NOT_TRACK=1

# Runtime + native-build toolchain: node-pty / oxc-parser / puppeteer-core need make+g++,
# `node` is required by the repo's own postinstall and build scripts,
# curl+jq are used by the docker.sh e2e probe.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq procps python3 make g++ nodejs npm unzip \
 && rm -rf /var/lib/apt/lists/*

# `--trust` is required: bun blocks lifecycle scripts by default and
# @opencode/cli refuses to run without its postinstall.
RUN bun install -g --trust --registry "${BUN_REGISTRY}" "@opencode/cli@${OPENCODE_CLI_VERSION}"

# Fail the build (not the later run) if the toolchain is broken.
RUN opencode2 --version \
 && opencode --version \
 && bun --version \
 && node --version \
 && jq --version \
 && git --version \
 && curl --version | head -1

# The repo is bind-mounted from the host (uid 1000) but runs as root here, so git
# refuses to touch it without this ("dubious ownership").
RUN git config --global --add safe.directory '*'

WORKDIR /repo

# Interactive shell by default; scripts/v2/docker.sh overrides the command.
CMD ["bash"]
