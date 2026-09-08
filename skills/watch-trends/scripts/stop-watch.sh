#!/usr/bin/env sh
# Ergonomic wrapper. All logic lives in stop-watch.mjs.
exec node "$(dirname "$0")/stop-watch.mjs" "$@"
