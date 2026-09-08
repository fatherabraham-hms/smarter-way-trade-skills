# Authentication, errors, and recovery

Every script prints a JSON object with `ok`, `stage`, `code`, `message`, and usually
`next_action`. This document maps each `code` to what happened and what to do. When a
script supplies `next_action`, prefer it — it is written for the specific situation.

## How authentication works

There is no login, API key, or account to register with watch-trends. The wallet *is*
the identity:

1. You set three CDP credentials (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`,
   `CDP_WALLET_SECRET`) in your secret store — see
   [https://docs.cdp.coinbase.com/x402/buyer/quickstart](https://docs.cdp.coinbase.com/x402/buyer/quickstart).
2. `print-wallet-address.mjs` resolves the dedicated `WatchTrendsBuyer` account through
   CDP and prints only its public address.
3. You fund that address with a small amount of USDC on Base.
4. The buyer requests a paid route without payment, reads the `402` response's
   `PAYMENT-REQUIRED` terms, validates them against local pins, signs an EIP-3009
   `TransferWithAuthorization`, and retries with a `PAYMENT-SIGNATURE` header.
5. The service settles through its facilitator and treats the settling wallet as the
   owner. `POST /services/watch-trends/v1/socket/session` returns an opaque token; the socket is bound to that
   payer.

The token lives in the supervisor's memory only. It is never written to disk, never
placed in a child process's `argv`, and is masked to a six-character prefix in every
diagnostic.

**One honest caveat:** the service accepts the token as a URL query parameter, so it
appears in the service's own TLS-terminated access logs. Its 30-minute TTL is the
mitigation. Nothing in transit is exposed — the connection is `wss://`.

## Setup and host errors

`/watch-trends` runs `node scripts/ready.mjs` first. On failure, follow
[setup.md](setup.md) for the reported `setup_step`. `preflight.mjs` is the same
gate under the older name.

| Code | What happened | What to do |
|---|---|---|
| `ok` | Prerequisites passed (`ready.mjs` / `preflight.mjs`) | Continue with status, then doctor before paying |
| `dest_refused` / `dest_inside_source` / `dest_contains_source` | Install dest is unsafe | Use a directory named `watch-trends` that is not `/`, `$HOME`, or a parent/child of the skill source |
| `node_runtime_missing` | Node is older than 22 | Install Node 22+, rerun `ready.mjs` |
| `deps_not_installed` | Pinned packages absent | `npm ci` in the skill directory. Do not fall back to another project's `node_modules`; the buyer must use the audited versions |
| `state_dir_unwritable` | Cannot write the ledger/spool | Set `WATCHTRENDS_STATE_DIR` to a writable path |
| `secret_in_public_config` | A secret key was found in `config.public` | It was ignored, not loaded. Remove it and set it in your secret store |

## Credential and wallet errors

| Code | What happened | What to do |
|---|---|---|
| `cdp_credentials_missing` | One or more of `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET` unset **in this process** | Create them in the CDP portal via [x402 buyer quickstart](https://docs.cdp.coinbase.com/x402/buyer/quickstart), set them per `references/security.md`, then reload: Linux/macOS `source` the profile and restart the agent; Windows close all terminals, open a new one (or sign out/in), restart the agent. Legacy `CB_AGENT_KIT_*` names still work. Editing a profile alone does not update a running process. Never paste values into chat |
| `shared_wallet_refused` | The resolved account looks like a general trading wallet | Use `WATCHTRENDS_CDP_ACCOUNT_NAME=WatchTrendsBuyer`. Only the user may set `WATCHTRENDS_ALLOW_SHARED_WALLET=1`, and only if they accept exposing that balance |
| `payer_address_mismatch` | Resolved wallet is not `WATCHTRENDS_EXPECTED_PAYER` | Nothing was signed. Fix whichever value is wrong |
| `wallet_needs_usdc` | Requirements were valid but settlement failed on balance | Send USDC on **Base** (not Ethereum mainnet) to the printed address. Never share keys or seed phrases |

## Payment and contract errors

| Code | What happened | What to do |
|---|---|---|
| `service_not_ready` | Health, discovery, or the session route is unavailable | Stop before payment; retry after the deploy is live |
| `service_contract_mismatch` | Live contract differs from the pinned fields | **No payment.** The mismatched fields are listed. Have the operator confirm the change, then rerun doctor with `--force` |
| `service_contract_updated` | Discovery version bumped and pinned fields changed | Review the diff with the user before spending. Never auto-accept |
| `payment_requirements_rejected` | Payee, network, asset, scheme, amount, or resource outside the allowlist | The buyer refused to sign. Show the mismatched field. Do not change a safety pin until the operator confirms the official configuration |
| `clock_skew_detected` | Host clock more than 10s from the server | x402 authorizations expire 60s after signing, so payments would fail confusingly. Enable automatic time sync (`sudo timedatectl set-ntp true`; macOS System Settings → General → Date & Time; Windows Settings → Time & language → Sync now), then rerun doctor |
| `daily_spend_cap_reached` | The ledger cap would be exceeded | Report spend and the reset time. The **user** changes `X402_DAILY_LIMIT_ATOMIC`; the agent never does |
| `spend_anomaly_detected` | Run spend exceeded 3x the projection | Show projection vs actual and ask whether to continue. At 10x the supervisor stops itself |
| `budget_locked` | Another buyer holds the ledger mutex | Nothing was attempted. Retry in a moment |
| `redirect_refused` | The service tried to redirect a payment request | Refused deliberately. Report to the operator |
| `probe_rate_limited` | The unpaid 402 probe ran 6+ times this hour | Not a failure. The cached verdict stands; rerun with `--force` later |
| `backend_unavailable` / `at_capacity` | The origin rejected a paid request during preflight | No settlement occurred. Honor `Retry-After` and retry later; do not create a new payment immediately |
| `forward_pending` | Payment settled but forwarding to the private backend is pending | Retry the identical request/signature only. Never sign a new payment for the same operation |
| `socket_session_replay_unrecoverable` | A socket payment was replayed but the origin could not return its token | Stop and contact the operator; do not buy repeatedly because the original payment may already be active |

## Watch errors

| Code | What happened | What to do |
|---|---|---|
| `start_price_implausible` | Price was zero, non-numeric, or 20%+ off the reference | Re-confirm the current price with the user and echo the resulting threshold band back before paying |
| `lease_expired` | A lease lapsed and could not be renewed | Signals for that ticker stopped. Restart it with `start-watch.sh` (a new $0.01 charge) |
| `no_watches` | Supervisor started with no tickers and no local records | Start a watch first, or pass `--ticker SYMBOL` |

## Socket errors

| Code | What happened | What to do |
|---|---|---|
| `socket_unavailable` | Transport dropped | Reconnects with jittered backoff on the **same** paid session. Never buys a session for a transport problem |
| `pong_timeout` | Missed the 10-second pong deadline | Reconnects with the same token; the session is still valid |
| `socket_session_expired` | The session TTL elapsed | Exactly one paid re-buy, subject to the 5-minute paid-session limiter |
| `socket_replaced_elsewhere` | Close 4001: another client claimed the payer's single connection slot | **Terminal. Never re-buy.** Another client legitimately owns the slot; buying again starts a two-client tug of war that bills both. Tell the user to stop the other client |
| `too_many_connections` | Close 1013 or an HTTP rate limit/capacity response | Back off; surface any retry delay |
| `socket_unauthorized` | Close 4401: the session token was rejected | Stop and require explicit session recovery; do not blindly loop purchases |
| `socket_hello_mismatch` | The socket bound to a different wallet than the payer | Closed without creating anything. Do not retry payment until the operator investigates |
| `socket_protocol_unrecognized` | A frame type, schema, or missing disclosure outside the approved contract | Closed safely, no further spend. The operator must confirm the socket protocol |
| `socket_closed` | A close code outside the known table | Raw code surfaced, no further spend. Pending service-side confirmation of close-code meanings |
| `supervisor_already_running` | The single-instance lock is held by a live PID | Exited without spending. Stop that process first; the PID is in the output |
| `session_token_lost` | An unexpired paid session is on disk but its token died with the process | The charge is unrecoverable. Report the wasted $0.01 and remaining minutes, then rerun with `--accept-session-loss` only after the user agrees |

### Close-code handling

| Code | Action | Spends? |
|---|---|---|
| 1000, 1001, 1006, 1011, 1012 | Reconnect with backoff, same token | No |
| 1013 (capacity) | Reconnect with a longer backoff, same token | No |
| 4003 (zombie/pong timeout) | Reconnect with backoff, same token | No |
| 4002 (expired) | One paid re-buy, rate limited | Yes, $0.01 |
| 4001 (replaced) | **Terminal, never re-buy** | No |
| 4401 (unauthorized token) | Stop; require explicit recovery | No |
| anything else | Stop and surface the raw code | No |

Unknown close codes still stop without spending: the difference between "re-buy" and
"never re-buy" is real money.

## Gap and recovery

| Code | What happened | What to do |
|---|---|---|
| `gap_detected` | The socket was down for a measurable window | Always reported to the user with `from`/`to`, whether or not recovery runs |
| `recovery_unavailable` | The catch-up route is not advertised by this deployment | Report the gap window; spend nothing on a guessed route |
| `gap_recovery_skipped` | Recovery disabled, or budget is down to what keeps the watch alive | Report the gap; keeping the lease alive takes priority over backfilling |

## Notification errors

| Code | What happened | What to do |
|---|---|---|
| `notify_not_configured` | No `WATCHTRENDS_NOTIFY_CMD` | Warning only. Signals are still spooled. Tell the user plainly they will only see signals when they next ask the agent |
| `notify_command_failed` | The hook exited non-zero, timed out, or was not executable | Retried 3x with backoff, then marked `notified:false` in the spool. **The socket and lease are untouched** — a broken notifier must never cost the user their paid session |

## What the scripts never print

CDP secrets, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, socket tokens, and Telegram bot
tokens. Diagnostics carry masked six-character prefixes. A Telegram 401 does not echo
the request URL, because the URL embeds the token.
