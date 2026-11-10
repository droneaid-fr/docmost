#!/usr/bin/env bash
# Cross-build the arm64 image on an amd64 host without editing upstream's Dockerfile.
#
# Why: under qemu-user emulation, the client build (Vite 8 / rolldown) deadlocks.
# This script derives a Dockerfile in which only the `builder` stage runs on the
# build platform (natively). Its output (dist/) is platform-independent JS. The
# installer and runtime stages, including native deps like bcrypt, still run for
# the target platform.
#
# Usage (from the repo root):
#   droneaid/docker/build-arm64.sh [tag] [output]
#   output: "docker" (default, writes ./docmost-arm64.tar) or any buildx --output value
# The image's "Source code" link and revision label use HEAD (override with SOURCE_COMMIT=...).
# Only deploy an image whose commit is pushed to github.com/droneaid-fr/docmost.
set -euo pipefail

tag="${1:-docmost-droneaid:local-arm64}"
output="${2:-type=docker,dest=docmost-arm64.tar}"
repo_root="$(git rev-parse --show-toplevel)"
tmp_dockerfile="$(mktemp)"
trap 'rm -f "$tmp_dockerfile"' EXIT

if ! grep -q '^FROM base AS builder$' "$repo_root/Dockerfile"; then
  echo "Upstream Dockerfile no longer has 'FROM base AS builder'; update this script." >&2
  exit 1
fi
source_commit="${SOURCE_COMMIT:-$(git -C "$repo_root" rev-parse HEAD)}"
if [ -n "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]; then
  echo "warning: uncommitted changes; the image will not match $source_commit (do not deploy it)." >&2
fi
pnpm_version="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$repo_root/package.json")"

sed "s|^FROM base AS builder\$|FROM --platform=\$BUILDPLATFORM node:26-slim AS builder\nRUN npm install -g pnpm@${pnpm_version} \&\& npm cache clean --force|" \
  "$repo_root/Dockerfile" > "$tmp_dockerfile"

docker buildx build --platform linux/arm64 -f "$tmp_dockerfile" -t "$tag" \
  --build-arg SOURCE_COMMIT="$source_commit" --output "$output" "$repo_root"
