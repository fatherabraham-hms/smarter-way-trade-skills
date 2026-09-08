/**
 * Configuration loading.
 *
 * Public safety pins may live in a `config.public` file next to the skill so a
 * non-technical user can copy the shipped example and edit it. Secrets may not:
 * loadPublicFile() refuses any key on the secret list, which turns "I pasted my
 * bot token into the config file" from a silent leak into a hard error.
 *
 * Environment variables always win over the file.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_CDP_ACCOUNT_NAME,
  DEFAULT_DAILY_LIMIT_ATOMIC,
  DEFAULT_SERVICE_PREFIX,
  DEFAULT_GAP_MIN_SECONDS,
  DEFAULT_MAX_AMOUNT_ATOMIC,
  DEFAULT_NETWORK,
  DEFAULT_PAY_TO,
  KNOWN_TRADING_ACCOUNTS,
  USDC_BASE_ASSET,
} from "./constants.mjs";

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Secrets belong in the runtime secret store, never in a config file. */
export const SECRET_ENV_NAMES = [
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  // Legacy Agent Kit names — still accepted, never preferred in messages.
  "CB_AGENT_KIT_CLIENT_API_KEY",
  "CB_AGENT_KIT_CLIENT_SECRET",
  "CB_AGENT_KIT_WALLET_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
];

/**
 * The three credentials the CDP / x402 buyer needs.
 * Primary names match https://docs.cdp.coinbase.com/x402/buyer/quickstart.
 * `legacy` aliases remain accepted for older installs.
 */
export const CDP_CREDENTIALS = [
  { primary: "CDP_API_KEY_ID", legacy: "CB_AGENT_KIT_CLIENT_API_KEY" },
  { primary: "CDP_API_KEY_SECRET", legacy: "CB_AGENT_KIT_CLIENT_SECRET" },
  { primary: "CDP_WALLET_SECRET", legacy: "CB_AGENT_KIT_WALLET_SECRET" },
];

let publicFileCache;

function loadPublicFile() {
  if (publicFileCache !== undefined) return publicFileCache;
  const candidate = process.env.WATCHTRENDS_CONFIG || path.join(SKILL_ROOT, "config.public");
  const result = { values: {}, path: null, rejectedSecrets: [] };
  try {
    const raw = fs.readFileSync(candidate, "utf8");
    result.path = candidate;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (SECRET_ENV_NAMES.includes(key)) {
        result.rejectedSecrets.push(key);
        continue;
      }
      result.values[key] = value;
    }
  } catch {
    /* absent config file is normal */
  }
  publicFileCache = result;
  return result;
}

function read(name, fallback) {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const file = loadPublicFile();
  const fromFile = file.values[name];
  if (fromFile !== undefined && fromFile !== "") return fromFile;
  return fallback;
}

function readBigInt(name, fallback) {
  const raw = read(name, null);
  if (raw === null) return fallback;
  try {
    const parsed = BigInt(String(raw).trim());
    if (parsed < 0n) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function readInt(name, fallback) {
  const raw = read(name, null);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name, fallback) {
  const raw = read(name, null);
  if (raw === null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** Root for the budget ledger, session metadata, signal spool, and locks. */
export function stateDir() {
  const configured = read("WATCHTRENDS_STATE_DIR", null);
  if (configured) return path.resolve(configured);
  return path.join(os.homedir() || os.tmpdir(), ".watch-trends");
}

export function statePath(...parts) {
  return path.join(stateDir(), ...parts);
}

/** Create the state directory with owner-only permissions. */
export function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function loadConfig() {
  const file = loadPublicFile();
  const apiBaseUrl = String(read("WATCHTRENDS_API_BASE_URL", DEFAULT_API_BASE_URL)).replace(/\/+$/, "");
  const servicePrefix = `/${String(read("WATCHTRENDS_SERVICE_PREFIX", DEFAULT_SERVICE_PREFIX))
    .replace(/^\/+|\/+$/g, "")}`;
  return {
    apiBaseUrl,
    servicePrefix: servicePrefix === "/." ? "" : servicePrefix,
    expectedX402Version: 2,
    payTo: String(read("WATCHTRENDS_EXPECTED_PAY_TO", DEFAULT_PAY_TO)).trim().toLowerCase(),
    network: String(read("WATCHTRENDS_EXPECTED_NETWORK", DEFAULT_NETWORK)).trim(),
    asset: String(read("WATCHTRENDS_EXPECTED_ASSET", USDC_BASE_ASSET)).trim(),
    accountName: String(read("WATCHTRENDS_CDP_ACCOUNT_NAME", DEFAULT_CDP_ACCOUNT_NAME)).trim(),
    expectedPayer: String(read("WATCHTRENDS_EXPECTED_PAYER", "")).trim().toLowerCase(),
    maxAmountAtomic: readBigInt("X402_MAX_AMOUNT_ATOMIC", DEFAULT_MAX_AMOUNT_ATOMIC),
    dailyLimitAtomic: readBigInt("X402_DAILY_LIMIT_ATOMIC", DEFAULT_DAILY_LIMIT_ATOMIC),
    allowSharedWallet: readBool("WATCHTRENDS_ALLOW_SHARED_WALLET", false),
    recoverGaps: readBool("WATCHTRENDS_RECOVER_GAPS", true),
    gapMinSeconds: readInt("WATCHTRENDS_GAP_MIN_SECONDS", DEFAULT_GAP_MIN_SECONDS),
    notifyCmd: read("WATCHTRENDS_NOTIFY_CMD", null),
    notifyFormat: String(read("WATCHTRENDS_NOTIFY_FORMAT", "text")).trim().toLowerCase(),
    stateDir: stateDir(),
    configFile: file.path,
    rejectedSecretsInConfigFile: file.rejectedSecrets,
  };
}

export function apiPath(config, suffix) {
  const pathSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${config.servicePrefix || ""}${pathSuffix}`;
}

export function apiUrl(config, suffix) {
  return `${config.apiBaseUrl}${apiPath(config, suffix)}`;
}

export function assertWebSocketUrl(url, config, expectedPath) {
  let actual;
  let base;
  try {
    actual = new URL(url);
    base = new URL(config.apiBaseUrl);
  } catch {
    return { ok: false, code: "invalid_ws_url", message: "The service returned an invalid WebSocket URL." };
  }
  const expectedScheme = process.env.WATCHTRENDS_TEST_MODE === "1" && base.hostname === "localhost"
    ? "ws:"
    : "wss:";
  if (actual.protocol !== expectedScheme) {
    return { ok: false, code: "invalid_ws_url", message: `Refusing a WebSocket URL that does not use ${expectedScheme}.` };
  }
  if (actual.host !== base.host) {
    return { ok: false, code: "ws_url_host_mismatch", message: "The service returned a WebSocket URL on a different host; refusing to send the session token there." };
  }
  if (actual.pathname !== expectedPath) {
    return { ok: false, code: "ws_url_path_mismatch", message: "The service returned a WebSocket URL with an unexpected path." };
  }
  return { ok: true, url: actual };
}

/**
 * Report which CDP credential names are set, without ever reading a value back
 * out. Callers get booleans, not secrets.
 */
export function cdpCredentialStatus() {
  return CDP_CREDENTIALS.map(({ primary, legacy }) => ({
    name: primary,
    legacy,
    set: Boolean(process.env[primary] || process.env[legacy]),
    via: process.env[primary] ? primary : process.env[legacy] ? legacy : null,
  }));
}

export function missingCdpCredentials() {
  return cdpCredentialStatus().filter((c) => !c.set).map((c) => c.name);
}

/**
 * Refuse to spend from a general trading wallet.
 *
 * Returns null when the account is acceptable, or a diagnostic when it is not.
 * The agent surfaces the diagnostic; it must not set the override itself.
 */
export function checkWalletIsolation(accountName, allowShared) {
  const normalized = String(accountName || "").trim().toLowerCase();
  const isShared = KNOWN_TRADING_ACCOUNTS.includes(normalized);
  if (!isShared) return null;
  if (allowShared) {
    return {
      severity: "warning",
      code: "shared_wallet_override_active",
      message:
        `Paying from "${accountName}", which looks like a general trading account. ` +
        "WATCHTRENDS_ALLOW_SHARED_WALLET is set, so this is allowed, but the wallet's whole balance is exposed to automated spending.",
    };
  }
  return {
    severity: "error",
    code: "shared_wallet_refused",
    message:
      `Refusing to pay from "${accountName}", which looks like a general trading account. ` +
      `Use the dedicated buyer account by setting WATCHTRENDS_CDP_ACCOUNT_NAME=${DEFAULT_CDP_ACCOUNT_NAME}, ` +
      "or set WATCHTRENDS_ALLOW_SHARED_WALLET=1 yourself if you accept the risk.",
  };
}

/** HTTPS-only, with a loopback escape hatch reserved for local service tests. */
export function assertUrlAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "invalid_url", message: `Not a valid URL: ${url}` };
  }
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (process.env.WATCHTRENDS_TEST_MODE === "1" && loopback) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, code: "invalid_url", message: "Loopback URL must be http or https." };
    }
    return { ok: true, url: parsed };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "insecure_api_url",
      message: `Refusing to talk to a non-HTTPS endpoint: ${parsed.protocol}//${parsed.host}`,
    };
  }
  return { ok: true, url: parsed };
}
