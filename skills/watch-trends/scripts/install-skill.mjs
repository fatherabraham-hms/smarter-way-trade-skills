#!/usr/bin/env node
/**
 * Copy this skill into a runtime skills directory and install pinned deps.
 * Spends nothing. Does not set secrets. Refuses unsafe --dest paths and
 * preserves an existing dest config.public.
 *
 * Usage:
 *   node scripts/install-skill.mjs --runtime claude --scope user
 *   node scripts/install-skill.mjs --runtime cursor --scope project
 *   node scripts/install-skill.mjs --runtime codex --scope user
 *   node scripts/install-skill.mjs --runtime hermes
 *   node scripts/install-skill.mjs --runtime openclaw --dest /path/to/workspace/skills/watch-trends
 *   node scripts/install-skill.mjs --dest /explicit/path/watch-trends
 */

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { SKILL_ROOT } from "./lib/config.mjs";
import {
  copySkillTree,
  destErrorMessage,
  invokeHint,
  resolveAndValidateInstallDest,
} from "./lib/install.mjs";
import { emit, run } from "./lib/output.mjs";

const STAGE = "install-skill";

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

run(STAGE, async () => {
  const argv = process.argv.slice(2);
  const runtime = String(flag(argv, "--runtime") || "").toLowerCase() || null;
  const scope = String(flag(argv, "--scope") || "user").toLowerCase();
  const destFlag = flag(argv, "--dest");

  if (!runtime && !destFlag) {
    const usage = destErrorMessage("usage");
    emit({
      ok: false,
      stage: STAGE,
      code: "usage",
      message: usage.message,
      next_action: usage.next_action,
    });
    process.exit(2);
  }

  const resolved = resolveAndValidateInstallDest({
    runtime,
    scope,
    dest: destFlag,
    skillRoot: SKILL_ROOT,
    home: os.homedir(),
  });
  if (!resolved.ok) {
    const text = destErrorMessage(resolved.code);
    emit({
      ok: false,
      stage: STAGE,
      code: resolved.code,
      message: resolved.message || text.message,
      next_action: text.next_action,
    });
    process.exit(2);
  }

  const dest = resolved.dest;
  const alreadyHere = Boolean(resolved.alreadyHere) || path.resolve(dest) === path.resolve(SKILL_ROOT);
  let preserved = [];
  if (!alreadyHere) {
    preserved = copySkillTree(SKILL_ROOT, dest).preserved;
  }

  const npm = spawnSync("npm", ["ci"], {
    cwd: dest,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (npm.status !== 0) {
    emit({
      ok: false,
      stage: STAGE,
      code: "deps_not_installed",
      dest,
      copied: !alreadyHere,
      preserved,
      message: npm.stderr?.trim() || npm.stdout?.trim() || "npm ci failed",
      next_action: `cd ${dest} && npm ci`,
    });
    process.exit(1);
  }

  emit({
    ok: true,
    stage: STAGE,
    code: "ok",
    dest,
    copied: !alreadyHere,
    already_installed: alreadyHere,
    preserved,
    invoke: invokeHint(runtime),
    next_action:
      `Skill is at ${dest}. Restart the agent so it discovers /watch-trends. ` +
      "Then run node scripts/ready.mjs from that directory. If credentials are missing, read references/setup.md.",
  });
});
