# Smarter Way LLC Trade Skills

An index of portable agent skills for trading and x402 services.

## Skills index

| Skill | What it does | Details |
|---|---|---|
| `watch-trends` | `/watch-trends` — pay for watch-trends signals and receive them over an outbound WebSocket. Checks host prerequisites first; setup is a reference, not a second skill. | [`skills/watch-trends/README.md`](skills/watch-trends/README.md) |

Agents should use each skill's details page before installing it. The details page
contains the supported runtimes, exact install command, prerequisites, verification
command, and the link to the canonical `SKILL.md`.

## Install a skill

From the skill's details page, clone this repository and copy only the selected skill
into the runtime's skill directory. The directory name must stay `watch-trends` so
Claude/Cursor expose `/watch-trends` and Codex exposes `$watch-trends`.

```bash
git clone --depth 1 https://github.com/fatherabraham-hms/abes-trade-skills.git
cd abes-trade-skills/skills/watch-trends
node scripts/install-skill.mjs --runtime claude --scope user
```

Use a runtime-specific destination (see [`skills/watch-trends/references/setup.md`](skills/watch-trends/references/setup.md)):

- Claude Code: `~/.claude/skills/watch-trends/` or `.claude/skills/watch-trends/`
- Cursor: `~/.cursor/skills/watch-trends/` or `.cursor/skills/watch-trends/`
- Codex: `~/.agents/skills/watch-trends/` or `.agents/skills/watch-trends/`
- Hermes: `~/.hermes/skills/watch-trends/`
- OpenClaw: `<workspace>/skills/watch-trends/`
- Other OpenAI-compatible agents: any local directory the agent can read and execute

Do not install workspace application code under `~/.openclaw/workspace-*`; use the
OpenClaw workspace's configured skills directory.

## Agent installation rules

1. Read the selected details page and `SKILL.md` before running commands.
2. Run `node scripts/ready.mjs` (and `doctor.mjs` before payment) before any paid action.
3. If ready fails, follow `references/setup.md` for that step only. Never request or commit API keys, wallet secrets, seed phrases, or PII.
4. Follow the skill's explicit-consent and spending rules.
5. Treat the repository's `main` branch as the stable catalog; use a branch only when the user explicitly requests unreleased changes.

`CDP_*` values come from the Coinbase CDP Portal. For failures, the skill's
`references/authentication-and-troubleshooting.md` is the canonical recovery guide.

## Repository layout

```text
skills/
└── <skill-name>/
    ├── README.md        # agent-facing details and installation
    ├── SKILL.md         # runtime instructions (/watch-trends)
    ├── references/      # setup and troubleshooting, loaded on demand
    └── scripts/         # deterministic helpers
```
