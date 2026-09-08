#!/usr/bin/env sh
# Ergonomic wrapper. All logic lives in notify-telegram.mjs, which reads the
# message from stdin and keeps the bot token out of argv and out of logs.
exec node "$(dirname "$0")/notify-telegram.mjs" "$@"
