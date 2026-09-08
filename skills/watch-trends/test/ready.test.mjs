import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillError, dependenciesInstalled } from "../scripts/lib/cdp.mjs";
import {
  copySkillTree,
  destErrorMessage,
  invokeHint,
  resolveInstallDest,
  validateInstallDest,
} from "../scripts/lib/install.mjs";
import { SETUP_DOC, assertReady, inspectReady } from "../scripts/lib/ready.mjs";

const CDP = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"];
const LEGACY = ["CB_AGENT_KIT_CLIENT_API_KEY", "CB_AGENT_KIT_CLIENT_SECRET", "CB_AGENT_KIT_WALLET_SECRET"];

function withoutCdp(fn) {
  const saved = {};
  for (const name of [...CDP, ...LEGACY]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("ready gate points a missing-credential host at setup.md", () => {
  assert.equal(dependenciesInstalled().ok, true, "run npm ci before this test");
  const result = withoutCdp(() => inspectReady());
  assert.equal(result.setup_doc, SETUP_DOC);
  assert.equal(result.setup_needed, true);
  assert.equal(result.ready, false);
  assert.equal(result.code, "cdp_credentials_missing");
  assert.equal(result.setup_step, "secrets");
  assert.match(result.next_action, /references\/setup\.md/);
});

test("assertReady throws SkillError with setup fields when credentials are missing", () => {
  assert.equal(dependenciesInstalled().ok, true, "run npm ci before this test");
  const err = withoutCdp(() => {
    try {
      assertReady();
      return null;
    } catch (caught) {
      return caught;
    }
  });
  assert.ok(err instanceof SkillError);
  assert.equal(err.code, "cdp_credentials_missing");
  assert.equal(err.extra.setup_needed, true);
  assert.equal(err.extra.setup_doc, SETUP_DOC);
  assert.equal(err.extra.setup_step, "secrets");
});

test("ready can skip the credential requirement for dry-run checks", () => {
  const result = withoutCdp(() => inspectReady({ requireCredentials: false }));
  assert.equal(result.problems.some((p) => p.code === "cdp_credentials_missing"), false);
});

test("install destinations match slash-command skill names", () => {
  const home = "/home/user";
  const cwd = "/repo";
  assert.equal(
    resolveInstallDest({ runtime: "claude", scope: "user", home, cwd }).dest,
    "/home/user/.claude/skills/watch-trends",
  );
  assert.equal(
    resolveInstallDest({ runtime: "claude", scope: "project", home, cwd }).dest,
    "/repo/.claude/skills/watch-trends",
  );
  assert.equal(
    resolveInstallDest({ runtime: "codex", scope: "user", home, cwd }).dest,
    "/home/user/.agents/skills/watch-trends",
  );
  assert.equal(
    resolveInstallDest({ runtime: "hermes", scope: "user", home, cwd }).dest,
    "/home/user/.hermes/skills/watch-trends",
  );
  assert.equal(
    resolveInstallDest({ runtime: "cursor", scope: "project", home, cwd }).dest,
    "/repo/.cursor/skills/watch-trends",
  );
  assert.equal(
    resolveInstallDest({ runtime: "openclaw", workspace: "/ws", home, cwd }).dest,
    "/ws/skills/watch-trends",
  );
  assert.equal(resolveInstallDest({ runtime: "openclaw", home, cwd }).ok, false);
  assert.equal(invokeHint("codex"), "$watch-trends");
  assert.equal(invokeHint("claude"), "/watch-trends");
});

test("validateInstallDest refuses root, home, and badly named paths", () => {
  const home = "/home/user";
  const skillRoot = "/repo/skills/watch-trends";
  assert.equal(validateInstallDest("/", { skillRoot, home }).code, "dest_refused");
  assert.equal(validateInstallDest(home, { skillRoot, home }).code, "dest_refused");
  assert.equal(validateInstallDest("/tmp/skills", { skillRoot, home }).code, "dest_refused");
  assert.equal(validateInstallDest(`${skillRoot}/nested/watch-trends`, { skillRoot, home }).code, "dest_inside_source");
  assert.equal(validateInstallDest("/repo/skills", { skillRoot, home }).code, "dest_refused");
  const here = validateInstallDest(skillRoot, { skillRoot, home });
  assert.equal(here.ok, true);
  assert.equal(here.alreadyHere, true);
  const ok = validateInstallDest("/home/user/.claude/skills/watch-trends", { skillRoot, home });
  assert.equal(ok.ok, true);
  assert.equal(ok.alreadyHere, false);
  assert.equal(
    validateInstallDest("/tmp/watch-trends", {
      skillRoot: "/tmp/watch-trends/skills/watch-trends",
      home,
    }).code,
    "dest_contains_source",
  );
});

test("destErrorMessage branches usage vs dest_required", () => {
  assert.match(destErrorMessage("usage").message, /Usage: install-skill/);
  assert.match(destErrorMessage("dest_required").message, /OpenClaw/);
  assert.match(destErrorMessage("dest_refused").message, /refused/i);
});

test("copySkillTree preserves an existing dest config.public", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watch-trends-copy-"));
  const from = path.join(tmp, "from");
  const to = path.join(tmp, "to", "watch-trends");
  try {
    fs.mkdirSync(path.join(from, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(from, "SKILL.md"), "source skill\n");
    fs.writeFileSync(path.join(from, "config.public"), "WATCHTRENDS_API_BASE_URL=from-source\n");
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, "config.public"), "WATCHTRENDS_API_BASE_URL=keep-me\n");

    const result = copySkillTree(from, to);
    assert.deepEqual(result.preserved, ["config.public"]);
    assert.equal(fs.readFileSync(path.join(to, "SKILL.md"), "utf8"), "source skill\n");
    assert.equal(fs.readFileSync(path.join(to, "config.public"), "utf8"), "WATCHTRENDS_API_BASE_URL=keep-me\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
