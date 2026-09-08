/**
 * Local prerequisite gate. Spends nothing and touches no network.
 *
 * `/watch-trends` runs this before any watch action. Paid scripts call
 * assertReady() so a skipped skill still cannot spend on a broken host.
 */

import fs from "node:fs";

import { SkillError, dependenciesInstalled, installedVersions } from "./cdp.mjs";
import {
  cdpCredentialStatus,
  ensureStateDir,
  loadConfig,
  missingCdpCredentials,
} from "./config.mjs";
import { emit } from "./output.mjs";

export const MIN_NODE_MAJOR = 22;
export const SETUP_DOC = "references/setup.md";

const SETUP_STEP_BY_CODE = {
  node_runtime_missing: "install_node",
  deps_not_installed: "install_deps",
  state_dir_unwritable: "state_dir",
  cdp_credentials_missing: "secrets",
  secret_in_public_config: "secrets",
};

function setupStep(code) {
  return SETUP_STEP_BY_CODE[code] || "setup";
}

/**
 * Inspect the host. Returns a structured result; never throws.
 *
 * @param {{ requireCredentials?: boolean }} [options]
 */
export function inspectReady(options = {}) {
  const requireCredentials = options.requireCredentials !== false;
  const problems = [];
  const warnings = [];

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < MIN_NODE_MAJOR) {
    problems.push({
      code: "node_runtime_missing",
      message: `Node ${MIN_NODE_MAJOR}+ is required; this host has ${process.versions.node}.`,
    });
  }

  const deps = dependenciesInstalled();
  if (!deps.ok) {
    problems.push({
      code: "deps_not_installed",
      message: `Missing pinned dependencies: ${deps.missing.join(", ")}. Run "npm ci" inside the skill directory.`,
    });
  }

  const config = loadConfig();

  let stateDirWritable = false;
  try {
    ensureStateDir();
    const probe = `${config.stateDir}/.write-probe`;
    fs.writeFileSync(probe, "ok", { mode: 0o600 });
    fs.unlinkSync(probe);
    stateDirWritable = true;
  } catch (err) {
    problems.push({
      code: "state_dir_unwritable",
      message: `Cannot write to ${config.stateDir}: ${err.message}. Set WATCHTRENDS_STATE_DIR to a writable path.`,
    });
  }

  if (config.rejectedSecretsInConfigFile.length) {
    problems.push({
      code: "secret_in_public_config",
      message:
        `${config.configFile} contains secret keys (${config.rejectedSecretsInConfigFile.join(", ")}). ` +
        "They were ignored, not loaded. Remove them from that file and set them in your secret store instead.",
    });
  }

  const credentials = cdpCredentialStatus();
  const missing = missingCdpCredentials();
  if (requireCredentials && missing.length) {
    problems.push({
      code: "cdp_credentials_missing",
      message:
        `These CDP variables are not set: ${missing.join(", ")}. ` +
        "Follow https://docs.cdp.coinbase.com/x402/buyer/quickstart to create them in the CDP portal, " +
        "export CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET, then reload " +
        "(Linux/macOS: source ~/.bashrc or ~/.zshrc and restart the agent; " +
        "Windows: close all terminals, open a new one, restart the agent). " +
        "Legacy CB_AGENT_KIT_* names still work. Do not paste values into chat.",
    });
  }

  if (!config.notifyCmd) {
    warnings.push({
      code: "notify_not_configured",
      message:
        "No WATCHTRENDS_NOTIFY_CMD is set. Signals will still be spooled locally, but you will only see them when you next ask the agent.",
    });
  }

  const first = problems[0] || null;
  const ok = problems.length === 0;
  const code = ok ? "ok" : first.code;
  const step = ok ? null : setupStep(code);

  return {
    ok,
    ready: ok,
    code,
    setup_needed: !ok,
    setup_doc: SETUP_DOC,
    setup_step: step,
    node_version: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    dependencies: installedVersions(),
    state_dir: config.stateDir,
    state_dir_writable: stateDirWritable,
    config_file: config.configFile,
    credentials_present: credentials.map((c) => ({ name: c.name, set: c.set })),
    api_base_url: config.apiBaseUrl,
    cdp_account_name: config.accountName,
    problems,
    warnings,
    next_action: ok
      ? "Host is ready. Run node scripts/status.mjs, then node scripts/doctor.mjs before any paid start."
      : `Prerequisites are not met (${code}). Read ${SETUP_DOC} and complete the "${step}" step, then rerun node scripts/ready.mjs. Do not start a watch yet.`,
  };
}

/** Throw SkillError when the host cannot safely start a paid watch. */
export function assertReady(options = {}) {
  const result = inspectReady(options);
  if (!result.ok) {
    throw new SkillError(result.code, result.next_action, {
      setup_needed: true,
      setup_doc: result.setup_doc,
      setup_step: result.setup_step,
      problems: result.problems,
    });
  }
  return result;
}

/**
 * Emit the ready failure and exit. Paid CLIs call this instead of duplicating
 * the try/catch. Dry-runs skip the credential requirement so price/CLI checks
 * still work before CDP is configured.
 */
export function failIfNotReady(stage, options = {}) {
  try {
    return assertReady(options);
  } catch (err) {
    if (err instanceof SkillError) {
      emit({ ok: false, stage, code: err.code, message: err.message, ...err.extra });
      process.exit(1);
    }
    throw err;
  }
}

export function emitReadyFields(result) {
  return {
    ready: result.ready,
    setup_needed: result.setup_needed,
    setup_doc: result.setup_doc,
    setup_step: result.setup_step,
    node_version: result.node_version,
    platform: result.platform,
    dependencies: result.dependencies,
    state_dir: result.state_dir,
    state_dir_writable: result.state_dir_writable,
    config_file: result.config_file,
    credentials_present: result.credentials_present,
    api_base_url: result.api_base_url,
    cdp_account_name: result.cdp_account_name,
    problems: result.problems,
    warnings: result.warnings,
    next_action: result.next_action,
  };
}
