# Setting secrets securely

The agent must never see these values. Set them yourself, in a place your agent
process can read as an environment variable, then tell the agent "done" — it
checks only that the *names* are set.

## What is secret and what is not

| Secret — secret store only | Public — fine in `config.public` |
|---|---|
| `CDP_API_KEY_ID` | `WATCHTRENDS_API_BASE_URL` |
| `CDP_API_KEY_SECRET` | `WATCHTRENDS_EXPECTED_PAY_TO` |
| `CDP_WALLET_SECRET` | `WATCHTRENDS_EXPECTED_NETWORK` / `_ASSET` |
| `TELEGRAM_BOT_TOKEN` | `X402_MAX_AMOUNT_ATOMIC`, `X402_DAILY_LIMIT_ATOMIC` |
| `TELEGRAM_CHAT_ID` | `WATCHTRENDS_CDP_ACCOUNT_NAME`, `WATCHTRENDS_STATE_DIR` |

`config.public` actively refuses secret keys. If you paste one in, it is ignored
and preflight reports `secret_in_public_config` — the value is not silently loaded.

## Getting CDP / x402 credentials

Follow the official guide:
**[CDP x402 buyer quickstart](https://docs.cdp.coinbase.com/x402/buyer/quickstart)**

That page is the source of truth for the env var names and for installing the CDP /
x402 buyer SDK. This skill already pins `@coinbase/cdp-sdk` via `npm ci` in the skill
directory; you only need to create credentials and export them.

### Create the values in your Coinbase account

1. Sign in to the [CDP Portal](https://portal.cdp.coinbase.com). A project is created
   on first sign-in if you do not already have one.
2. Create a **Secret API key**:
   - Open [API Keys → Secret](https://portal.cdp.coinbase.com/api-keys/secret).
   - Select your project from the top drop-down.
   - Click **Create API key**, name it, optionally restrict IP / permissions, and
     create it.
   - Save the **API key ID** and **API key secret** immediately. The secret is shown
     once — put it straight into your password manager or secret store.
3. Create a **Wallet Secret** (required for the SDK to sign payments):
   - Open [Non-custodial Wallet → Security](https://portal.cdp.coinbase.com/wallets/non-custodial/security).
   - Click **Generate** / **Generate Wallet Secret**.
   - Save it immediately — you will not be able to view it again.
4. Export the official names (from the quickstart):

```bash
export CDP_API_KEY_ID="your-api-key-id"
export CDP_API_KEY_SECRET="your-api-key-secret"
export CDP_WALLET_SECRET="your-wallet-secret"
```

You never enter a seed phrase or private key anywhere in this skill. The buyer wallet
is created and signed for through CDP using these three credentials.

### Legacy name mapping

Older Agent Kit installs used different names. This skill still accepts them, but new
setups should use the official `CDP_*` names:

| Official (preferred) | Legacy (still accepted) |
|---|---|
| `CDP_API_KEY_ID` | `CB_AGENT_KIT_CLIENT_API_KEY` |
| `CDP_API_KEY_SECRET` | `CB_AGENT_KIT_CLIENT_SECRET` |
| `CDP_WALLET_SECRET` | `CB_AGENT_KIT_WALLET_SECRET` |

If both are set, the official `CDP_*` value wins.

## Critical: writing the file is not enough

Saving credentials into `~/.bashrc`, `~/.zshrc`, or the Windows User environment store
does **not** put them into an already-running shell or agent. Preflight will keep
reporting `cdp_credentials_missing` until the process that runs the skill actually
inherits the new environment. The agent must tell the user this explicitly in step 2.

| Platform | After saving the values, the user must |
|---|---|
| Linux / macOS | `source` the profile in the shell that will launch the agent, **then restart the agent** |
| Windows | Close every open terminal, start a **new** terminal (or sign out/in if the agent was launched from the Start menu / a shortcut), **then restart the agent** |

Do not say "done" and re-run preflight until that reload has happened. Editing a profile
file alone never updates a process that is already running.

## Setting them, by platform

### Linux and macOS — shell session

Add to `~/.bashrc` (bash) or `~/.zshrc` (zsh), or a `chmod 600` file you source from
there:

```bash
export CDP_API_KEY_ID='...'
export CDP_API_KEY_SECRET='...'
export CDP_WALLET_SECRET='...'
```

Leading space before the command keeps it out of shell history in most shells. Then
**load them into the current shell and restart the agent**:

```bash
# bash
source ~/.bashrc
# zsh
source ~/.zshrc
```

If you put the exports in a separate file (recommended):

```bash
chmod 600 ~/.config/watch-trends/env
source ~/.config/watch-trends/env
```

Then quit and relaunch the agent from **that same shell** so it inherits the exports.
An agent started before `source` still will not see the credentials.

### macOS — Keychain (better)

Store once:

```bash
security add-generic-password -a "$USER" -s CDP_WALLET_SECRET -w
```

It prompts for the value instead of taking it from the command line, so it never
lands in your shell history. Read it back when launching the agent:

```bash
export CDP_WALLET_SECRET="$(security find-generic-password -a "$USER" -s CDP_WALLET_SECRET -w)"
```

Repeat for `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` with matching `-s` names.

### Linux — libsecret (better)

```bash
secret-tool store --label='CDP wallet secret' service watch-trends key wallet_secret
export CDP_WALLET_SECRET="$(secret-tool lookup service watch-trends key wallet_secret)"
```

### Linux — systemd user service

Put the values in `~/.config/watch-trends/env`, `chmod 600`, and reference it:

```ini
[Service]
EnvironmentFile=%h/.config/watch-trends/env
```

Never put secrets directly in a unit file; unit files are world-readable. After editing
the env file: `systemctl --user daemon-reload` and restart the unit.

### Windows — user environment variables

Set each secret as a **User** environment variable (Settings → System → About →
Advanced system settings → Environment Variables, or PowerShell):

```powershell
[Environment]::SetEnvironmentVariable('CDP_API_KEY_ID', (Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText), 'User')
[Environment]::SetEnvironmentVariable('CDP_API_KEY_SECRET', (Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText), 'User')
[Environment]::SetEnvironmentVariable('CDP_WALLET_SECRET', (Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText), 'User')
```

Windows does **not** refresh an open session when you change User variables. After
saving:

1. Close **every** open terminal / PowerShell / Windows Terminal tab.
2. Open a **new** terminal (or sign out and back in if the agent is started from a
   Start-menu shortcut or Task Scheduler — those pick up User vars only at launch).
3. Restart the agent from that new session.

There is no Linux-style `source` for User environment variables. Leaving the old
terminal open is the usual reason preflight still says credentials are missing after
you "just set them."

### OpenClaw and Hermes

Use the runtime's own secrets configuration so the values are injected into the agent
process environment. Do not put them in a workspace file that gets committed.

If this Hermes instance forwards host-shell vars through an allowlist (common on
isolated installs), also:

1. Export the values in the **host** shell profile using the official `CDP_*` names.
2. Add the variable **names** (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`,
   `CDP_WALLET_SECRET`) to the allowlist.
3. `source` the host profile (Linux/macOS) or open a new terminal (Windows).
4. **Restart the Hermes container / gateway** from that refreshed shell so the
   forwarder sees the new values.

Editing the allowlist alone does not inject secrets that are not present in the
launching shell.

### Claude Code, Cursor, and other local agents

These inherit the environment of the shell that launched them. Export / source the
variables in that shell, then **restart the agent** from it. Or use a launcher script
that sources a `chmod 600` env file before `exec`-ing the agent.

### Railway or another host

Use the platform's Variables UI. Values set there are injected as environment
variables and are not written into your repository.

## Verifying without exposing anything

```bash
node scripts/ready.mjs
```

It reports `{"name": "CDP_WALLET_SECRET", "set": true}` and nothing more. No
script in this skill prints a secret value, a payment signature, a payment response
header, or a socket token. Diagnostics carry masked prefixes only.

## If you think a credential leaked

1. Revoke the API key in the CDP portal immediately.
2. Move any remaining balance out of the buyer wallet address.
3. Create new credentials and a new buyer account name.

Because the buyer wallet is dedicated and holds roughly a week of spend, the blast
radius of a leak here is a few dollars — which is the entire reason the skill refuses
to pay from your main trading wallet.
