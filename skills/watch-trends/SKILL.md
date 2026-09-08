---
name: watch-trends
description: Starts, monitors, and stops paid watch-trends trading-signal watches over an outbound WebSocket. Use when the user runs /watch-trends or $watch-trends, asks to watch a ticker, check watch status, stop a watch, replay signals, or receive trend alerts. Always check host prerequisites first; if they fail, follow references/setup.md instead of guessing.
user-invocable: true
argument-hint: "[ticker] | status | stop <ticker> | signals"
---

# /watch-trends

Pay for watch-trends signals with x402 and receive them on an outbound-only
WebSocket. Every script prints one JSON object (the supervisor prints JSON Lines).

Invoke as `/watch-trends` in Claude Code, Cursor, OpenClaw, and Hermes; as
`$watch-trends` in Codex. Natural-language "watch BTC" is the same skill.

## Non-negotiable rules

1. **Never ask the user to paste a secret, key, seed phrase, or PII into chat.**
   Name the variable, point at `references/security.md`, and verify presence only.
2. **Never spend without explicit consent.** State the dollar cost first.
   `ready.mjs`, `preflight.mjs`, `doctor.mjs`, `budget-plan.mjs`, and `status.mjs`
   spend nothing. Start, renew, stop, and the supervisor do.
3. **Never raise a spend cap, fund a wallet, or set `WATCHTRENDS_ALLOW_SHARED_WALLET`
   for the user.** Tell them the variable and value; they set it.
4. **Never propose localhost receivers, ngrok/cloudflared, open ports, or disposable
   webhook sites.** The socket is outbound-only by design.
5. **Signals are informational, not investment advice.** Pass the service `disclosure`
   through verbatim.
6. **Do not start a watch until `ready.mjs` is ok.** If it is not, read
   [references/setup.md](references/setup.md) and complete only the failed step.

## Every invocation (do this first)

Work from this skill directory (`SKILL.md` lives here). Then:

```
node scripts/ready.mjs
node scripts/status.mjs
```

| `ready.mjs` | What you do |
|---|---|
| `ok: true` | Continue with the requested action below |
| `ok: false` | Read `setup_doc` (always `references/setup.md`) and do `setup_step` only. Do not pay. After the user says they reloaded the agent, rerun `ready.mjs`. |

`status.mjs` first in any later conversation about watches — the supervisor is
detached, so a dead stream is otherwise invisible.

## What the user asked for

**No args / status** — report supervisor, leases, spend today, and alerts from
`status.mjs`. Add `--signals --limit 20` if they want recent signals.

**Start / watch `<ticker>`** — only after ready is ok:

1. `node scripts/budget-plan.mjs 1 <hours>` (default 24). Disclose the dollar
   cost and that this is a recurring charge, not a setup fee. Get consent.
2. `node scripts/doctor.mjs`. Stop on any failure; use its `next_action`.
   Never pay past `service_not_ready`, `service_contract_mismatch`, or
   `clock_skew_detected`.
3. Get the current price yourself or ask the user. **Echo the price and the
   resulting threshold band back for confirmation before paying.**
4. `scripts/start-watch.sh <ticker> <segment> <threshold> --start-price <p>`
   Pass `--reference-price` when you have an independent quote. A price more
   than 20% off is refused as `start_price_implausible`.
5. Start the supervisor **detached** per `references/runtimes.md`:
   `node scripts/watch-session.mjs --ticker <T> --hours <H>`
   It must survive this chat turn. It emits JSON Lines, not one result object.

**Stop `<ticker>`** — `scripts/stop-watch.sh <ticker>` is paid ($0.01).
SIGTERM to the supervisor ends the stream with no further charges; leases keep
running until they expire.

**Signals** — `node scripts/status.mjs --signals --limit 20`

## What costs money

| Action | Price | Notes |
|---|---:|---|
| Start a watch | $0.01 | Once per ticker |
| Renew | $0.01 | Every 30 min per ticker |
| Socket session | $0.01 | Every 25 min, per wallet not per ticker |
| Stop a watch | $0.01 | Teardown is also paid |
| Gap recovery | $0.01 | Only if a disconnect needs catch-up |

One ticker running continuously costs about **$1.06/day**. Say so before the
first payment. The shipped `X402_DAILY_LIMIT_ATOMIC` is a $200/day runaway
ceiling, not a budget.

## When something breaks

Read [references/authentication-and-troubleshooting.md](references/authentication-and-troubleshooting.md).
Every script returns a `code`; that document maps each code to a safe message.

Never retry in a way that spends money on:
`socket_replaced_elsewhere`, `socket_protocol_unrecognized`, `socket_closed`,
`service_contract_mismatch`, `payment_requirements_rejected`, `shared_wallet_refused`,
`clock_skew_detected`, `supervisor_already_running`.

## Known limitations (say these honestly)

- Do not claim guaranteed delivery. A redeploy or socket gap can drop signals.
- Only trend signals are pushed. Money and health events stay in `status.mjs`.
- Closing the laptop stops the stream.
- The socket token appears in the service's TLS-terminated access logs; its
  30-minute TTL is the mitigation.

## Paid diagnostics (opt-in only)

`node scripts/smoke-socket.mjs --spend --listen --duration 35` buys a session
($0.01). Only after a doctor failure that a live test would actually diagnose.

## Setup (only when ready fails)

Do not walk a ready host through onboarding. When `ready.mjs` fails, follow
[references/setup.md](references/setup.md) for that `setup_step` only:

- `install_node` / `install_deps` / `state_dir` — host
- `secrets` — CDP credentials, never pasted into chat

To place this skill into Claude, Codex, Hermes, Cursor, or OpenClaw:

```bash
node scripts/install-skill.mjs --runtime claude --scope user
```

Runtimes and secret stores are in that same file.

## Reference files

- [references/setup.md](references/setup.md) — install the skill, CDP secrets, fund wallet, notify
- [references/security.md](references/security.md) — setting secrets per platform, never in chat
- [references/runtimes.md](references/runtimes.md) — detached supervisor per host
- [references/authentication-and-troubleshooting.md](references/authentication-and-troubleshooting.md)
- [references/costs.md](references/costs.md)
- [references/notifications.md](references/notifications.md)
- [references/service-contract.md](references/service-contract.md)
