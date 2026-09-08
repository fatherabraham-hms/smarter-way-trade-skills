# Service contract: what is verified and what is still assumed

The pins in `scripts/lib/constants.mjs` are **safety values, not trusted defaults**.
`doctor.mjs --discovery` re-reads the live contract on every run and fails closed on a
mismatch, because the difference between "session TTL is 30 minutes" and "session TTL
is 3 minutes" is the difference between $1/day and $10/day.

## Verified against the live deployment

Read from `GET /services/watch-trends/v1/` and
`GET /services/watch-trends/v1/x402.json` at
`https://agents.smarterway.tech`.

### Paid routes

| Route | Price | Body |
|---|---:|---|
| `POST /services/watch-trends/v1/watches` | 10000 | required `ticker`, `segment`, `threshold`, `start_price`; optional `webhook_url`, `confidence`, `asset_type` (`crypto`\|`stock`) |
| `POST /services/watch-trends/v1/watches/{ticker}/renew` | 10000 | empty |
| `DELETE /services/watch-trends/v1/watches/{ticker}` | 10000 | empty |
| `POST /services/watch-trends/v1/socket/session` | 10000 | optional `ttl_minutes`, max 30 |
| `GET /services/watch-trends/v1/watches` | 10000 | empty |
| `GET /services/watch-trends/v1/watches/{ticker}/events` | 10000 | optional `limit`; flagged `debug:true` |

### Socket

```
path                     /services/watch-trends/v1/ws/signals
auth                     token query param from POST /services/watch-trends/v1/socket/session
session_ttl_minutes      30
ping_interval_sec        25
pong_timeout_sec         10
one_connection_per_payer true
client_must_pong         true
lease_window_minutes     30
```

### Payment requirement on `/services/watch-trends/v1/socket/session`

```
scheme              exact
network             eip155:8453
asset               0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   (Base USDC)
payTo               0x7f985b1764f79faa42a4622bb605b23c8eb5abea
amount              10000
maxTimeoutSeconds   60
resource            https://agents.smarterway.tech/services/watch-trends/v1/socket/session
extra               { name: "USD Coin", version: "2" }            (EIP-712 domain)
```

The buyer pins `chainId` 8453 and the USDC contract itself. Only the EIP-712 domain
name and version are taken from the server, and only so the facilitator rebuilds the
same digest.

### Contract pinning

`doctor.mjs` stores the discovery `version` plus a SHA-256 over the normalized fields
the skill actually depends on: paid routes, prices, session TTL, ping interval, pong
deadline, connection policy, and the `POST /watches` required fields. Cosmetic
description changes do not trip it; a price or TTL change does.

- Version bump **with** field changes → `service_contract_updated`, reported with a
  diff for user review.
- Field changes **without** a version bump → `service_contract_mismatch`, the harder
  failure, because a silent change is the dangerous case.

Neither auto-accepts. Both stop before any payment.

## Still assumed, pending confirmation

The skill stays fail-closed on each of these: it stops and reports rather than guessing
with a funded wallet attached.

### WebSocket message catalog

The current origin sends `hello`, `ping`, and `signal`; the client also accepts `pong`.
Any other frame type, a signal without a payload, or a signal without a `disclosure`
closes the socket as `socket_protocol_unrecognized` and stops.

### Close-code table

The origin implementation defines:

| Code | Assumed meaning | Consequence if wrong |
|---|---|---|
| 4001 | Replaced | Treated as terminal; no re-buy |
| 4002 | Session expired | Re-buy, subject to the paid-session limiter |
| 4003 | Pong deadline exceeded | Reconnects on the same token |
| 1013 | Capacity | Must back off without spending |
| 4401 | Unauthorized token | Stop; do not blindly buy again |

Any code outside this set stops with the raw code surfaced and no further spend.

### Replica and delivery policy

The origin uses Postgres-backed global admission and LISTEN/NOTIFY fan-out. A redeploy
or measurable socket gap can still drop real-time delivery, so the skill reports gaps
and does not claim at-least-once delivery.

### Session overlap on re-buy

Buying a new session replaces the existing payer connection. The supervisor closes the
old socket first and records the resulting gap window.

### Renew response shape

`expiryFromResponse()` reads `expires_at`, `lease_expires_at`, `watch.expires_at`, or
`expiry`, then falls back to `ttl_minutes`/`window_minutes`, then to the documented
30-minute window. Confirming the actual field would remove the fallback chain.

### Catch-up cursor semantics

`GET /watches/{ticker}/events` takes a `limit` but exposes no cursor, so gap recovery
polls the most recent events and deduplicates locally by event id. A cursor parameter
would make recovery exact instead of best-effort.

## Re-verifying

```bash
node scripts/doctor.mjs --discovery --force
```

`--force` bypasses the 10-minute contract cache. Discovery and health responses are
cached because an agent may run doctor repeatedly; the unpaid 402 probe additionally
fires at most 6 times per hour before reporting `probe_rate_limited`, so onboarding
never trips the service's own limiter.
