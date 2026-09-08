# What this costs and how to cap it

## The pricing that matters

Every paid route costs 10,000 atomic Base USDC — $0.01. USDC has 6 decimals, so
10,000 atomic = $0.01 and 1,000,000 atomic = $1.00.

| Route | Price | How often |
|---|---:|---|
| `POST /watches` | $0.01 | Once per ticker |
| `POST /watches/{t}/renew` | $0.01 | Every 30 minutes, **per ticker** |
| `POST /socket/session` | $0.01 | Every 25 minutes, **per wallet** |
| `DELETE /watches/{t}` | $0.01 | Once, if you tear down early |
| `GET /watches/{t}/events` | $0.01 | Gap recovery only |

**The headline number is misleading on its own.** "$0.01 to start a watch" is true and
irrelevant: the lease and the session both expire on a 30-minute clock, so staying
watched and connected is a recurring charge.

## Why the two cadences differ

Renewals **extend** the existing lease by 30 minutes from its current expiry. Renewing
15 minutes early therefore costs nothing extra — it just buys a retry window — and the
steady-state cadence stays one renewal per 30 minutes.

Sessions are **replaced**, not extended. A new session's 30-minute TTL starts when you
buy it, so re-buying 5 minutes before expiry genuinely shortens the cadence to 25
minutes: about 58 sessions a day rather than 48.

That extra ~$0.10/day is the price of not having a gap in delivery every half hour.
`budget-plan.mjs` prices the real cadence rather than the flattering one.

## Worked examples

| Scenario | Starts | Renewals | Sessions | Per day |
|---|---:|---:|---:|---:|
| 1 ticker, 24h | 1 | 47 | 58 | **$1.06** |
| 3 tickers, 24h | 3 | 141 | 58 | **$2.02** |
| 10 tickers, 24h | 10 | 470 | 58 | **$5.38** |
| 1 ticker, 2h | 1 | 3 | 5 | $0.09 |

Renewals scale with ticker count; sessions do not, because one socket serves every
watch owned by the same wallet. Watching more tickers is cheaper per ticker.

Run it yourself:

```bash
node scripts/budget-plan.mjs 3 24
```

## Sizing the cap

The shipped default is `X402_DAILY_LIMIT_ATOMIC=200000000` — $200.00/day.

That is roughly 400 continuously watched tickers, or about 190x the cost of one. **It
is a runaway ceiling, not a budget.** A cap two orders of magnitude above normal usage
does not protect you day to day; three tighter mechanisms do:

**1. The funded wallet balance is the real limit.** The dedicated `WatchTrendsBuyer`
account holds only what you put in it. `budget-plan.mjs` recommends roughly one week of
projected spend — about $7.42 for a single continuous ticker. A drained $7 wallet is a
much cheaper failure than a $200 daily cap.

**2. Rate limiters bound the burn rate.** Paid sessions are capped at one per 5 minutes
($0.12/hour maximum). Renewals are scheduled per ticker, not triggered by events. Gap
recovery is one call per affected ticker. A tight reconnect loop cannot outrun these
regardless of what the cap says.

**3. The anomaly guard is the actual early warning.** Warning at 80% of $200 would fire
after $160 of unexpected spend, which is useless. The supervisor instead compares actual
spend against the `budget-plan.mjs` projection for the current run: it warns at 3x and
stops itself at 10x. For one ticker that means flagging at around $3 rather than $160.

## Lowering the cap

If you want a hard stop closer to your real usage, take `recommended_atomic` from
`budget-plan.mjs` (your projection plus 25%) and set it in your secret store:

```bash
export X402_DAILY_LIMIT_ATOMIC=1325000    # $1.325/day, one continuous ticker
```

The agent will compute and recommend this value but **will never set or raise it**.
If the cap is below the projection, `budget-plan.mjs` reports
`daily_cap_below_projection` and tells you how many hours the stream will actually last,
so you can choose deliberately instead of discovering it when the stream dies.

## How spend is tracked

`${WATCHTRENDS_STATE_DIR}/budget.json` records every charge as
`{ts, route, atomic, tx_prefix, status}`. Budget is **reserved under an exclusive lock
before signing** and reconciled afterwards, so two concurrent buyers cannot both pass
the cap check and then both spend. A refused payment rolls its reservation back.

The window is a UTC day. `status.mjs` reports spend today, in-flight reservations, cap
remaining, and the exact reset timestamp.

## Reaching the cap

Hitting the cap is a **clean stop**, not a crash. The supervisor stops renewing, closes
the socket, emits `daily_spend_cap_reached` with the reset time, and exits. Existing
leases keep running until they expire on their own.

## Money you can lose without getting anything

Two cases, both reported rather than hidden:

- **`session_token_lost`** — a crash loses the in-memory token for a session you already
  paid for. The remaining minutes are gone. The next run reports the wasted $0.01 and
  the expiry time, and refuses to buy a replacement without `--accept-session-loss`.
- **`rejected_after_signing`** — the service returned a non-2xx answer after the payment
  was signed. The facilitator may still have settled, so it is recorded as spend rather
  than quietly freed. Your ledger stays truthful.
