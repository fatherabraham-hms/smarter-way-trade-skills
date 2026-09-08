/**
 * CDP SDK / x402 buyer access.
 *
 * Credentials use the official CDP_* env names from
 * https://docs.cdp.coinbase.com/x402/buyer/quickstart, with legacy
 * CB_AGENT_KIT_* accepted as fallbacks.
 *
 * Resolution is deliberately strict: the SDK must come from this skill's own
 * node_modules, installed from the committed lockfile. The previous generation
 * of this buyer probed sibling workspaces for a copy, which meant the code that
 * signs payments could silently run an unaudited version.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { checkWalletIsolation, SKILL_ROOT } from "./config.mjs";

const require = createRequire(import.meta.url);

export class SkillError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/** True when the pinned dependencies are installed next to this skill. */
export function dependenciesInstalled() {
  const missing = [];
  for (const name of ["@coinbase/cdp-sdk", "ws"]) {
    try {
      require.resolve(name);
    } catch {
      missing.push(name);
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Read installed versions from disk rather than by requiring package.json,
 * because packages with an `exports` map (the CDP SDK among them) refuse that
 * specifier and would report a misleading "not installed".
 */
export function installedVersions() {
  const versions = {};
  for (const name of ["@coinbase/cdp-sdk", "ws"]) {
    try {
      const manifest = path.join(SKILL_ROOT, "node_modules", ...name.split("/"), "package.json");
      versions[name] = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    } catch {
      versions[name] = null;
    }
  }
  return versions;
}

async function loadSdk() {
  const { ok, missing } = dependenciesInstalled();
  if (!ok) {
    throw new SkillError(
      "deps_not_installed",
      `Missing pinned dependencies: ${missing.join(", ")}. Run "npm ci" inside the skill directory. ` +
        "This skill will not fall back to another project's node_modules, because the buyer must use the audited versions.",
      { missing }
    );
  }
  const mod = await import("@coinbase/cdp-sdk");
  const CdpClient = mod.CdpClient || mod.default?.CdpClient;
  if (!CdpClient) throw new SkillError("deps_not_installed", "@coinbase/cdp-sdk did not export CdpClient.");
  return CdpClient;
}

function credentials() {
  // Prefer CDP_* (official x402 / CDP SDK names); accept legacy CB_AGENT_KIT_*.
  const apiKeyId = process.env.CDP_API_KEY_ID || process.env.CB_AGENT_KIT_CLIENT_API_KEY;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET || process.env.CB_AGENT_KIT_CLIENT_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET || process.env.CB_AGENT_KIT_WALLET_SECRET;
  const missing = [];
  if (!apiKeyId) missing.push("CDP_API_KEY_ID");
  if (!apiKeySecret) missing.push("CDP_API_KEY_SECRET");
  if (!walletSecret) missing.push("CDP_WALLET_SECRET");
  if (missing.length) {
    throw new SkillError(
      "cdp_credentials_missing",
      `These CDP variables are not set: ${missing.join(", ")}. ` +
        "Create them in the Coinbase Developer Platform portal " +
        "(https://docs.cdp.coinbase.com/x402/buyer/quickstart), set them in your " +
        "runtime's secret store, then reload the environment " +
        "(Linux/macOS: source the profile and restart the agent; Windows: close all terminals, open a new one, restart the agent). " +
        "Legacy CB_AGENT_KIT_* names still work if already set. Do not paste the values into chat.",
      { missing }
    );
  }
  return { apiKeyId, apiKeySecret, walletSecret };
}

/**
 * Resolve the dedicated buyer account, refusing a general trading wallet
 * unless the user explicitly opted in.
 */
export async function getBuyerAccount(config) {
  const isolation = checkWalletIsolation(config.accountName, config.allowSharedWallet);
  if (isolation?.severity === "error") {
    throw new SkillError(isolation.code, isolation.message, { account_name: config.accountName });
  }

  const CdpClient = await loadSdk();
  const cdp = new CdpClient(credentials());
  const account = await cdp.evm.getOrCreateAccount({ name: config.accountName });

  if (config.expectedPayer && account.address.toLowerCase() !== config.expectedPayer) {
    throw new SkillError(
      "payer_address_mismatch",
      `The resolved wallet ${account.address} does not match WATCHTRENDS_EXPECTED_PAYER. Refusing to sign.`,
      { resolved: account.address }
    );
  }

  return { account, cdp, warning: isolation?.severity === "warning" ? isolation : null };
}
