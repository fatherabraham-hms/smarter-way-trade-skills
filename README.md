# Smarter Way LLC Trade Skills

An index of portable agent skills for trading and x402 services.

## Skills index

| Skill | What it does | Details |
|---|---|---|
| `watch-trends-x402-setup` | Sets up a dedicated CDP buyer wallet, pays for watch-trends signals, and receives them over an outbound WebSocket. | [`skills/watch-trends-x402-setup/README.md`](skills/watch-trends-x402-setup/README.md) |

Agents should use each skill's details page before installing it. The details page
contains the supported runtimes, exact install command, prerequisites, verification
command, and the link to the canonical `SKILL.md`.

## Install a skill

From the skill's details page, clone this repository and copy only the selected skill
into the runtime's skill directory. Do not copy secrets or local state into the
repository.

```bash
git clone --depth 1 https://github.com/fatherabraham-hms/abes-trade-skills.git
cp -R abes-trade-skills/skills/watch-trends-x402-setup /path/to/runtime/skills/
cd /path/to/runtime/skills/watch-trends-x402-setup
npm ci
node scripts/preflight.mjs
```

Use a runtime-specific destination:

- Cursor project: `.cursor/skills/`
- Cursor personal: `~/.cursor/skills/`
- Claude Code: `.claude/skills/`
- OpenClaw/Hermes: the workspace skills directory already scanned by that runtime
- Other OpenAI-compatible agents: any local directory the agent can read and execute

Do not install workspace application code under `~/.openclaw/workspace-*`; use the
OpenClaw workspace's configured skills directory.

## Agent installation rules

1. Read the selected details page and `SKILL.md` before running commands.
2. Run the documented no-spend preflight/doctor checks before any paid action.
3. Never request or commit API keys, wallet secrets, seed phrases, or PII.
4. Follow the skill's explicit-consent and spending rules.
5. Treat the repository's `main` branch as the stable catalog; use a branch only when
   the user explicitly requests unreleased changes.

The selected skill's details page is the starting point for setup. It explains that
`CDP_*` values come from the Coinbase CDP Portal, then directs the agent to run
`preflight.mjs` and `doctor.mjs` before payment. For failures, the skill's
`references/authentication-and-troubleshooting.md` is the canonical recovery guide.

## Repository layout

```text
skills/
└── <skill-name>/
    ├── README.md   # agent-facing details and installation
    ├── SKILL.md    # runtime instructions
    └── scripts/    # deterministic helpers
```
