#!/usr/bin/env bash
# Fails when core client code imports an `@/ee/...` path or name that our stub tree
# (apps/client/src/droneaid/ee-stubs) does not provide. Run after every upstream sync.
# Also runs inside the client test suite (src/droneaid/ee-stubs/ee-stubs.test.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node droneaid/scripts/check-ee-stubs.mjs "$@"
