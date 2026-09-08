# Getting notified when a signal fires

`/watch-trends` does not require a notifier. Signals are always spooled.
Prefer an existing OpenClaw / Hermes / Telegram channel; do not start with
BotFather. See [setup.md](setup.md) for the default path.

## Three layers, and why

The socket lives in a **detached background process**, not in your chat session. By the
time a trend fires, the conversation that started the supervisor has long ended. So
"the agent tells you" was never implementable — the last hop has to be something the
supervisor itself can run.

**Layer 1 — the spool (always on, nothing to configure).** Every validated signal is
appended to `${WATCHTRENDS_STATE_DIR}/signals.jsonl` before anything else is attempted,
mode `0600`, deduplicated by event id so gap-recovery replays never double-report. This
is not a notification; it is the guarantee that a misconfigured notifier can never turn
a signal you paid for into a lost one. Read it back with:

```bash
node scripts/status.mjs --signals --limit 20
```

**Layer 2 — the notify hook (the actual push).** `WATCHTRENDS_NOTIFY_CMD` names a
command the supervisor runs once per new signal, with the message on **stdin**.

**Layer 3 — the shipped Telegram wrapper.** `scripts/notify-telegram.sh`, so a
non-technical user gets phone alerts without writing any code.

## Telegram setup (recommended)

### 1. Create a bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Give it a display name, then a username ending in `bot` (e.g. `my_trends_alerts_bot`).
4. BotFather replies with a token like `123456789:AAF...`. **This is a secret.**

### 2. Find your chat id

1. Send any message to your new bot (it will not reply — that is expected).
2. Message [@userinfobot](https://t.me/userinfobot), which replies with your numeric id.

For a group instead: add your bot to the group, send a message there, and use the
group's id — it starts with `-100`.

### 3. Set both values securely

These are **your** secrets, set exactly like the CDP credentials. Never paste them into
chat; see [security.md](security.md).

```bash
export TELEGRAM_BOT_TOKEN='123456789:AAF...'
export TELEGRAM_CHAT_ID='987654321'
export WATCHTRENDS_NOTIFY_CMD='scripts/notify-telegram.sh'
```

After saving, reload the environment the same way as CDP credentials: Linux/macOS
`source` the profile (or env file) and restart the agent / supervisor; Windows close
all terminals, open a new one, restart the agent / supervisor. Doctor's `--notify`
check reads the **current** process environment — a profile edit you have not sourced
will look like the token is missing.

If you run the supervisor under systemd or launchd, put these in the same environment
file the unit reads — the supervisor passes its own environment to the hook. A systemd
unit needs `systemctl --user daemon-reload` and a restart of the unit after the env
file changes; `source` alone does not update it.

### 4. Verify without sending anything

```bash
node scripts/doctor.mjs --notify
```

This checks the spool is writable, the command resolves and is executable, both
variables are set, and authenticates the token against Telegram's free `getMe`
endpoint. **No message is sent and no money is spent.** The token is never printed —
not even in a 401 error, because the request URL embeds it.

## Other channels

The hook is a plain command, so any channel works without this skill ever handling a
provider secret. Set `WATCHTRENDS_NOTIFY_CMD` to:

| Channel | Command |
|---|---|
| ntfy.sh | `curl -sf -d @- https://ntfy.sh/your-secret-topic` |
| Linux desktop | `xargs -0 notify-send "watch-trends"` |
| macOS desktop | `terminal-notifier -title watch-trends -message "$(cat)"` |
| Slack / Discord webhook | your own small script that wraps stdin in the right JSON |
| OpenClaw | `openclaw message send --to <chat>` |
| Anything | any executable that reads stdin |

Pick a genuinely unguessable ntfy topic — anyone who knows the topic name can read your
signals.

For a webhook that needs JSON rather than text:

```bash
export WATCHTRENDS_NOTIFY_FORMAT=json
```

stdin then carries `{event_id, ticker, received_at, payload, disclosure}` for your own
tooling to reshape.

## Message shape

```
watch-trends: BTC up 5.2% (threshold 5) at 65000
time: 2026-08-02T17:26:37.928Z

Informational only. Not investment advice.
```

One actionable line, then the service-provided disclosure **verbatim**. The disclosure
is never summarised away or dropped when truncating to Telegram's 4096-character limit
— the headline gets shortened instead.

## Why the message goes on stdin, not argv

Signal content is remote-controlled data. Interpolating it into a command line would
both expose it to anyone running `ps` and hand an attacker a shell-injection surface.
Only the command string *you wrote* is ever seen by the shell; the payload only ever
arrives on stdin.

## When the notifier breaks

Failures are contained. A hook that exits non-zero, hangs, or is missing gets retried
three times with backoff, then the signal is marked `notified:false` in the spool and
logged as `notify_command_failed`. The supervisor keeps running and the socket stays
open — **a broken notifier must never cost you the paid session or the watch lease.**

Find undelivered signals with:

```bash
node scripts/status.mjs --signals
```

`status.mjs` also reports the undelivered count in its `alerts`, which is why the agent
should run it at the start of any conversation about watches.

Invocations are serialized through a queue with a 10-second timeout each, so a burst of
signals cannot fork-bomb the host or stall the socket read loop.

## What is deliberately NOT pushed

Only trend signals go to your notification channel. Money and health events —
`daily_spend_cap_reached`, `spend_anomaly_detected`, `session_token_lost`, gap windows,
terminal socket errors — stay in the supervisor log and `status.mjs`.

The honest consequence: **if the supervisor stops, nothing pings you.** You will notice
only when signals stop arriving. The mitigation is a habit rather than another push
channel — the agent runs `status.mjs` at the start of any conversation touching watches
and reports a stopped supervisor before answering anything else.

If you want to be paged when the stream dies, watch the supervisor process with your
own monitoring (a systemd `OnFailure=` unit, for example). That is out of scope for
this skill by design.
