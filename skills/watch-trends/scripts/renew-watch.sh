#!/usr/bin/env sh
# Ergonomic wrapper. All logic lives in renew-watch.mjs.
exec node "$(dirname "$0")/renew-watch.mjs" "$@"
