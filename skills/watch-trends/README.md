# watch-trends

Slash skill (`/watch-trends`, Codex `$watch-trends`) for paying for watch-trends
subscriptions with x402 and receiving trading signals over an outbound-only
WebSocket. It does not require localhost, an inbound port, a tunnel, or a
disposable webhook endpoint.

Setup is **not** a second skill. `/watch-trends` runs `node scripts/ready.mjs`
first. If the host is not ready, the agent follows
[`references/setup.md`](references/setup.md) for the failed step only.

## Supported runtimes

| Runtime | Install dest | Invoke |
|---|---|---|
| Claude Code | `~/.claude/skills/watch-trends/` or `.claude/skills/watch-trends/` | `/watch-trends` |
| Cursor | `~/.cursor/skills/watch-trends/` or `.cursor/skills/watch-trends/` | `/watch-trends` |
| Codex | `~/.agents/skills/watch-trends/` or `.agents/skills/watch-trends/` | `$watch-trends` |
| Hermes | `~/.hermes/skills/watch-trends/` | `/watch-trends` |
| OpenClaw | `<workspace>/skills/watch-trends/` | `/watch-trends` |
| Other agents | any directory the agent can read and execute | load `SKILL.md` |

## Coinbase CDP credentials

The `CDP_*` variables come from the user's Coinbase CDP Portal, not from this
GitHub repository and not from the watch-trends service. Full walkthrough:
[`references/setup.md`](references/setup.md) and
[`references/security.md`](references/security.md).

```bash
export CDP_API_KEY_ID="your-api-key-id"
export CDP_API_KEY_SECRET="your-api-key-secret"
export CDP_WALLET_SECRET="your-wallet-secret"
```

Never paste these values into chat, GitHub, Markdown, `config.public`, or command
arguments. Older `CB_AGENT_KIT_*` aliases still work.

## Install

From this skill directory:

```bash
node scripts/install-skill.mjs --runtime claude --scope user
```

Or copy the directory yourself, keeping the name `watch-trends`, then `npm ci`
and `node scripts/ready.mjs`. Destinations and OpenClaw `--dest` are in
[`references/setup.md`](references/setup.md).

Do not place secrets in this repository or under `~/.openclaw/workspace-*`.

## Use and verify

After install, restart the agent and invoke `/watch-trends` (or `$watch-trends`).
The skill:

1. Runs `ready.mjs` (Node, deps, writable state, credential *names*)
2. If that fails, follows `references/setup.md` for one step
3. Runs `status.mjs`
4. On start: budget disclosure, `doctor.mjs`, consent, start-watch, detached supervisor

```bash
node scripts/ready.mjs
node scripts/doctor.mjs
```

`ready.mjs` spends nothing and touches no network. `doctor.mjs` checks the live
origin without signing a payment. Do not continue when Doctor reports a failure.

The production service is `https://agents.smarterway.tech` under
`/services/watch-trends/v1`.

## Required host capabilities

- Node.js 22 or newer
- Network access to the production x402 origin
- A writable local state directory
- CDP credentials in the runtime secret store or environment

## Security

Never put CDP credentials, wallet secrets, Telegram tokens, seed phrases, or PII in
GitHub issues, Markdown, chat, `config.public`, command arguments, or committed files.

## Source files

- [`SKILL.md`](SKILL.md) — `/watch-trends` agent instructions
- [`references/setup.md`](references/setup.md) — install, secrets, wallet, notify
- [`references/authentication-and-troubleshooting.md`](references/authentication-and-troubleshooting.md)
- [`references/service-contract.md`](references/service-contract.md)
- [`references/runtimes.md`](references/runtimes.md)
- [`config.public.example`](config.public.example)
