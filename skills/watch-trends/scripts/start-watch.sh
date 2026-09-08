#!/usr/bin/env sh
# Ergonomic wrapper. All logic lives in start-watch.mjs so the skill works on
# hosts without bash, jq, or GNU coreutils.
exec node "$(dirname "$0")/start-watch.mjs" "$@"
