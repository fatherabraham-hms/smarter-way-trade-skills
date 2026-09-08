# Setup (invoke only when `ready.mjs` fails)

This is not a separate skill. `/watch-trends` runs `node scripts/ready.mjs`
first. Open this file only when that gate reports `setup_needed: true`, and
complete **only** the listed `setup_step`. Then rerun `ready.mjs`.

Never ask the user to paste a secret, key, seed phrase, or PII into chat.

```
- [ ] install_node
- [ ] install_deps
- [ ] state_dir
- [ ] secrets
- [ ] fund_wallet          # after ready is ok, before first payment
- [ ] notify               # optional; spool always works
```

## Place the skill in the runtime (`install_deps` or first-time install)

The directory name **must** be `watch-trends`. That is what becomes
`/watch-trends` in Claude Code and Cursor, and `$watch-trends` in Codex.

From this repository (or any checkout that already contains the skill):

```bash
# Claude Code — personal → /watch-trends
node scripts/install-skill.mjs --runtime claude --scope user

# Claude Code — this project
node scripts/install-skill.mjs --runtime claude --scope project

# Cursor — personal or project
node scripts/install-skill.mjs --runtime cursor --scope user
node scripts/install-skill.mjs --runtime cursor --scope project

# Codex — $watch-trends  (also scanned as ~/.agents/skills)
node scripts/install-skill.mjs --runtime codex --scope user
node scripts/install-skill.mjs --runtime codex --scope project

# Hermes
node scripts/install-skill.mjs --runtime hermes

# OpenClaw workspace
node scripts/install-skill.mjs --runtime openclaw --dest /path/to/workspace/skills/watch-trends
```

Manual copy if the helper is not yet on the host:

```bash
git clone --depth 1 https://github.com/fatherabraham-hms/abes-trade-skills.git
cp -R abes-trade-skills/skills/watch-trends /path/to/runtime/skills/watch-trends
cd /path/to/runtime/skills/watch-trends
npm ci
node scripts/ready.mjs
```

| Runtime | Destination | How to invoke |
|---|---|---|
| Claude Code (user) | `~/.claude/skills/watch-trends/` | `/watch-trends` |
| Claude Code (project) | `.claude/skills/watch-trends/` | `/watch-trends` |
| Cursor (user) | `~/.cursor/skills/watch-trends/` | `/watch-trends` |
| Cursor (project) | `.cursor/skills/watch-trends/` | `/watch-trends` |
| Codex (user) | `~/.agents/skills/watch-trends/` | `$watch-trends` or `/skills` |
| Codex (project) | `.agents/skills/watch-trends/` | `$watch-trends` |
| Hermes | `~/.hermes/skills/watch-trends/` | `/watch-trends` or ask to watch |
| OpenClaw | `<workspace>/skills/watch-trends/` | `/watch-trends` |

`~/.codex/skills/watch-trends/` still works for older Codex installs; prefer
`~/.agents/skills/`. Do not install workspace application code under
`~/.openclaw/workspace-*`.

After copying, **restart the agent** so it discovers the skill. Then run
`node scripts/ready.mjs` from the destination.

### `install_node`

Need Node.js 22 or newer. The user installs it; you do not download installers
into chat. Then rerun `ready.mjs`.

### `install_deps`

```bash
cd /path/to/skills/watch-trends
npm ci
```

Use this skill's own `package-lock.json`. Never fall back to another project's
`node_modules`.

### `state_dir`

Default is `~/.watch-trends`. If it is not writable, the user sets
`WATCHTRENDS_STATE_DIR` to a writable path and reruns `ready.mjs`.

## `secrets` — CDP credentials (one user prompt)

Send the user to the official CDP x402 buyer quickstart. Do **not** ask them
to paste values into chat.

1. Open [CDP x402 buyer quickstart](https://docs.cdp.coinbase.com/x402/buyer/quickstart).
2. In the [CDP Portal](https://portal.cdp.coinbase.com):
   - Sign in (a project is created on first sign-in).
   - Create a **Secret API key**: [API Keys → Secret](https://portal.cdp.coinbase.com/api-keys/secret)
     → **Create API key**. Save the **API key ID** and **API key secret** immediately —
     the secret is shown once.
   - Create a **Wallet Secret**: [Non-custodial Wallet → Security](https://portal.cdp.coinbase.com/wallets/non-custodial/security)
     → **Generate**. Save it immediately — it is also shown once.
3. Set these in their runtime secret store / shell profile (official names):

```bash
export CDP_API_KEY_ID="your-api-key-id"
export CDP_API_KEY_SECRET="your-api-key-secret"
export CDP_WALLET_SECRET="your-wallet-secret"
```

Legacy names still work if already configured:

| Official (preferred) | Legacy (still accepted) |
|---|---|
| `CDP_API_KEY_ID` | `CB_AGENT_KIT_CLIENT_API_KEY` |
| `CDP_API_KEY_SECRET` | `CB_AGENT_KIT_CLIENT_SECRET` |
| `CDP_WALLET_SECRET` | `CB_AGENT_KIT_WALLET_SECRET` |

Platform-specific stores: [security.md](security.md). This skill's `npm ci`
already installs `@coinbase/cdp-sdk`; the user does not need a separate Agent
Kit install.

### Writing the file is not enough

This is the usual reason `ready.mjs` still reports credentials missing:

- **Linux / macOS:** after saving to `~/.bashrc` / `~/.zshrc` (or a sourced env
  file), run `source ~/.bashrc` or `source ~/.zshrc` in the shell that launches
  the agent, then **restart the agent** from that shell.
- **Windows:** after setting User environment variables, close every open
  terminal, open a **new** one, then **restart the agent**.
- **OpenClaw:** put the names in the workspace / gateway secret store the
  runtime already uses. Do not write them into `config.public`.
- **Hermes:** add the **names** to the process allowlist (not the values in
  chat), then restart Hermes so the new environment is inherited.
- **Claude Code / Codex / Cursor:** secrets must be in the environment of the
  process that runs `node`. Profile edits do not reach an already-running IDE.

Only after they confirm the reload + agent restart, rerun `ready.mjs`. If it
still shows unset, ask whether they sourced/restarted; do not invent fixes.

## After ready is ok — before the first payment

These are not `ready.mjs` failures. `/watch-trends` does them as part of start.

### Fund the dedicated wallet

```bash
node scripts/print-wallet-address.mjs
```

Prints the `WatchTrendsBuyer` address. Ask the user to send a small amount of
USDC on Base — roughly one week of projected spend. That balance, not the daily
cap, is the real spend limit. Confirm with "done?"; never ask for a key.

### Notification channel (optional)

Signals are always spooled locally (`status.mjs --signals`). A push channel is
optional.

1. Prefer an existing OpenClaw, Hermes, or Telegram bot already on the host.
   Do not create a new BotFather bot by default.
2. After the user consents, set only non-secret keys (`WATCHTRENDS_NOTIFY_CMD`,
   optionally `WATCHTRENDS_NOTIFY_TARGET`) in `config.public` or the environment.
3. Verify with `node scripts/doctor.mjs --notify` (sends no message).
4. Recipes: [notifications.md](notifications.md).

### Cost disclosure and doctor

`/watch-trends` already requires these before start. Do not skip them after a
fresh setup:

```bash
node scripts/budget-plan.mjs 1 24
node scripts/doctor.mjs
```
