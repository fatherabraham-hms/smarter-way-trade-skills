#!/usr/bin/env node
/**
 * No-spend diagnostic ladder.
 *
 * Nothing in this file can spend money. Every stage is designed to fail before
 * a payment rather than after one, which is why the contract and clock checks
 * run ahead of the payment gate rather than alongside it.
 *
 * Usage:
 *   node scripts/doctor.mjs                 # run every no-spend stage
 *   node scripts/doctor.mjs --discovery     # run one stage
 *   node scripts/doctor.mjs --force         # bypass the 10-minute contract cache
 */

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";

import {
  CDP_CREDENTIALS,
  SKILL_ROOT,
  cdpCredentialStatus,
  ensureStateDir,
  loadConfig,
  apiUrl,
  missingCdpCredentials,
  checkWalletIsolation,
  assertUrlAllowed,
} from "./lib/config.mjs";
import { dependenciesInstalled, installedVersions } from "./lib/cdp.mjs";
import {
  clockSkewAcceptable,
  clockSkewSeconds,
  contractHash,
  deriveWsUrl,
  fetchWithTimeout,
  loadContract,
  loadHealth,
  parsePaymentRequired,
  probeAllowed,
  probePaymentGate,
  readPin,
  recoveryAvailable,
  validateContract,
  writePin,
} from "./lib/contract.mjs";
import { CONTRACT, MAX_CLOCK_SKEW_SEC, PRICE_ATOMIC } from "./lib/constants.mjs";
import { summary as ledgerSummary } from "./lib/ledger.mjs";
import { spoolStats } from "./lib/spool.mjs";
import { Notifier } from "./lib/notify.mjs";
import { emit, formatDollars, mask, run } from "./lib/output.mjs";
import { validateRequirement } from "./lib/x402.mjs";

const STAGE = "doctor";

run(STAGE, async () => {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const selected = argv.filter((a) => a.startsWith("--") && a !== "--force").map((a) => a.slice(2));
  const wanted = (name) => selected.length === 0 || selected.includes(name);

  const config = loadConfig();
  const stages = [];
  let contract = null;

  if (wanted("host")) stages.push(await stageHost(config));
  if (wanted("config")) stages.push(await stageConfig(config));
  if (wanted("service")) stages.push(await stageService(config));
  if (wanted("discovery")) {
    const result = await stageDiscovery(config, force);
    contract = result.contract;
    stages.push(result.stage);
  }
  if (wanted("x402-gate")) stages.push(await stageX402Gate(config));
  if (wanted("dry-run-payment")) stages.push(await stageDryRun(config));
  if (wanted("notify")) stages.push(await stageNotify(config));

  const failed = stages.find((s) => s.ok === false);
  const warnings = stages.flatMap((s) => s.warnings || []);

  emit({
    ok: !failed,
    stage: STAGE,
    code: failed ? failed.code : "ok",
    message: failed ? failed.message : "All requested no-spend checks passed. No payment was attempted.",
    stages,
    warnings,
    spend: "none",
    next_action: failed
      ? failed.next_action || failed.message
      : "Setup is verified. The next step is the first paid action, which needs explicit user consent.",
  });
  process.exit(failed ? 1 : 0);
});

/* ---------------------------------------------------------------- D0 host */

async function stageHost(config) {
  const problems = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 22) {
    problems.push(`Node 22+ is required; this host has ${process.versions.node}.`);
  }

  const deps = dependenciesInstalled();
  if (!deps.ok) {
    return failStage("host", "deps_not_installed",
      `Missing pinned dependencies: ${deps.missing.join(", ")}.`,
      'Run "npm ci" inside the skill directory. This skill will not fall back to another project\'s installed packages, because the buyer must use the pinned, audited versions.');
  }

  const caCount = tls.rootCertificates?.length ?? 0;
  if (caCount === 0) {
    problems.push("This Node build exposes no root certificates, so HTTPS verification cannot be trusted.");
  }

  let stateDirWritable = true;
  try {
    ensureStateDir();
    const probe = path.join(config.stateDir, ".write-probe");
    fs.writeFileSync(probe, "ok", { mode: 0o600 });
    fs.unlinkSync(probe);
  } catch (err) {
    stateDirWritable = false;
    problems.push(`Cannot write to ${config.stateDir}: ${err.message}`);
  }

  if (problems.length) {
    return failStage("host", "node_runtime_missing", problems.join(" "),
      "Fix the reported host problem, then rerun Doctor. No payment was attempted.");
  }

  return {
    stage: "host",
    ok: true,
    code: "ok",
    node_version: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    dependencies: installedVersions(),
    root_certificates: caCount,
    state_dir: config.stateDir,
    state_dir_writable: stateDirWritable,
  };
}

/* -------------------------------------------------------------- D1 config */

async function stageConfig(config) {
  const warnings = [];

  const urlCheck = assertUrlAllowed(config.apiBaseUrl);
  if (!urlCheck.ok) {
    return failStage("config", urlCheck.code, urlCheck.message,
      "Set WATCHTRENDS_API_BASE_URL to the canonical HTTPS service origin.");
  }

  const missingPins = [];
  if (!config.payTo) missingPins.push("WATCHTRENDS_EXPECTED_PAY_TO");
  if (!config.network) missingPins.push("WATCHTRENDS_EXPECTED_NETWORK");
  if (!config.asset) missingPins.push("WATCHTRENDS_EXPECTED_ASSET");
  if (missingPins.length) {
    return failStage("config", "public_config_missing",
      `These public safety pins are not set: ${missingPins.join(", ")}.`,
      "Set the listed public safety pins in the environment. The buyer will not sign until they match the service's 402.");
  }

  if (config.rejectedSecretsInConfigFile.length) {
    return failStage("config", "secret_in_public_config",
      `${config.configFile} contains secret keys (${config.rejectedSecretsInConfigFile.join(", ")}); they were ignored, not loaded.`,
      "Remove those keys from the public config file and set them in the runtime secret store instead.");
  }

  const missing = missingCdpCredentials();
  if (missing.length) {
    return failStage("config", "cdp_credentials_missing",
      `These CDP variables are not set: ${missing.join(", ")}.`,
      "Create CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET in the Coinbase Developer Platform portal (https://docs.cdp.coinbase.com/x402/buyer/quickstart), set them in the runtime secret manager, then reload: Linux/macOS source the profile and restart the agent; Windows close all terminals, open a new one, restart the agent. Legacy CB_AGENT_KIT_* names still work. Do not paste values into chat; reply only after reload and I will recheck.");
  }

  const isolation = checkWalletIsolation(config.accountName, config.allowSharedWallet);
  if (isolation?.severity === "error") {
    return failStage("config", isolation.code, isolation.message,
      "Use the dedicated buyer account. Do not set WATCHTRENDS_ALLOW_SHARED_WALLET on the user's behalf.");
  }
  if (isolation?.severity === "warning") warnings.push(isolation);

  if (config.maxAmountAtomic < PRICE_ATOMIC.session) {
    return failStage("config", "public_config_missing",
      `X402_MAX_AMOUNT_ATOMIC is ${config.maxAmountAtomic}, below the ${PRICE_ATOMIC.session} atomic price of a single call, so every payment would be refused.`,
      `Set X402_MAX_AMOUNT_ATOMIC to at least ${PRICE_ATOMIC.session}.`);
  }

  const ledger = ledgerSummary(config.dailyLimitAtomic);
  if (BigInt(ledger.remaining_atomic) < PRICE_ATOMIC.session) {
    warnings.push({
      code: "daily_spend_cap_reached",
      message: `Today's remaining budget (${formatDollars(BigInt(ledger.remaining_atomic))}) will not cover another call. Resets at ${ledger.resets_at}.`,
    });
  }

  return {
    stage: "config",
    ok: true,
    code: "ok",
    api_base_url: config.apiBaseUrl,
    expected_pay_to: config.payTo,
    expected_network: config.network,
    expected_asset: config.asset,
    cdp_account_name: config.accountName,
    credentials_present: cdpCredentialStatus().map((c) => ({
      name: c.name,
      legacy: c.legacy,
      set: c.set,
      via: c.via,
    })),
    max_amount_usd: formatDollars(config.maxAmountAtomic),
    daily_cap_usd: formatDollars(config.dailyLimitAtomic),
    spent_today_usd: formatDollars(BigInt(ledger.spent_atomic)),
    warnings,
  };
}

/* ------------------------------------------------------------- D2 service */

async function stageService(config) {
  let health;
  try {
    health = await loadHealth(config.apiBaseUrl, config.servicePrefix);
  } catch (err) {
    return failStage("service", "service_unhealthy",
      `Could not reach ${config.apiBaseUrl}: ${err.message}`,
      "The remote service is unavailable. No payment was attempted; retry later or contact the operator with this diagnostic.");
  }

  if (!health.health_ok || !health.ready_ok) {
    return failStage("service", "service_unhealthy",
      `Service reported health=${health.health_ok} ready=${health.ready_ok}.`,
      "The service is not ready. No payment was attempted; retry later.");
  }

  const skew = clockSkewSeconds(health.server_date);
  if (!clockSkewAcceptable(skew)) {
    return failStage("service", "clock_skew_detected",
      `This machine's clock is ${skew} seconds away from the service clock, beyond the ${MAX_CLOCK_SKEW_SEC}s tolerance.`,
      "x402 authorizations expire 60 seconds after signing, so payments will fail. Enable automatic time sync " +
        "(Linux: 'sudo timedatectl set-ntp true'; macOS: System Settings > General > Date & Time > Set automatically; " +
        "Windows: Settings > Time & language > Date & time > Sync now), then rerun Doctor. No payment was attempted.");
  }

  return {
    stage: "service",
    ok: true,
    code: "ok",
    health_ok: health.health_ok,
    ready_ok: health.ready_ok,
    clock_skew_sec: skew,
  };
}

/* ----------------------------------------------------------- D3 discovery */

async function stageDiscovery(config, force) {
  let contract;
  try {
    contract = await loadContract(config.apiBaseUrl, { force, servicePrefix: config.servicePrefix });
  } catch (err) {
    return {
      contract: null,
      stage: failStage("discovery", "service_not_ready",
        `Could not read the service contract: ${err.message}`,
        "Discovery is unavailable, so the paid socket route cannot be verified. No payment was attempted."),
    };
  }

  const { root, discovery } = contract;
  const mismatches = validateContract(root, discovery);
  const hash = contractHash(root, discovery);
  const pin = readPin();
  const warnings = [];

  if (mismatches.length) {
    return {
      contract,
      stage: failStage("discovery", "service_contract_mismatch",
        `The live contract differs from what this skill was built against: ${mismatches
          .map((m) => `${m.field} is ${m.actual} (expected ${m.expected})`)
          .join("; ")}.`,
        "The service changed its public contract. No payment was attempted; contact the operator with these fields before spending."),
    };
  }

  if (pin && pin.hash !== hash) {
    const versionChanged = pin.version !== discovery.version;
    warnings.push({
      code: versionChanged ? "service_contract_updated" : "service_contract_mismatch",
      message: versionChanged
        ? `Discovery version moved from ${pin.version} to ${discovery.version} and the pinned fields changed. Review before spending.`
        : `The pinned contract fields changed while discovery version stayed at ${discovery.version}. This is unexpected; review before spending.`,
      previous_hash: mask(pin.hash, 12),
      current_hash: mask(hash, 12),
    });
    if (!versionChanged) {
      return {
        contract,
        stage: failStage("discovery", "service_contract_mismatch",
          `The pinned contract fields changed without a discovery version bump (pin ${mask(pin.hash, 12)} vs live ${mask(hash, 12)}).`,
          "A silent contract change is the dangerous case. No payment was attempted; have the operator confirm the change, then rerun with --force."),
      };
    }
  }

  writePin({ version: discovery.version, hash, updated_at: new Date().toISOString() });

  const recovery = recoveryAvailable(discovery);
  if (!recovery) {
    warnings.push({
      code: "recovery_unavailable",
      message:
        "This deployment no longer advertises GET /watches/{ticker}/events, so missed signals cannot be recovered. " +
        "Gaps will still be reported, but no paid catch-up will be attempted.",
    });
  }

  return {
    contract,
    stage: {
      stage: "discovery",
      ok: true,
      code: "ok",
      from_cache: contract.from_cache,
      cache_age_sec: contract.age_sec,
      discovery_version: discovery.version,
      contract_hash: mask(hash, 12),
      socket: root.socket,
      lease_window_minutes: root.lease_window_minutes,
      ws_url: deriveWsUrl(config.apiBaseUrl, root.socket.path),
      paid_routes: root.paid_routes,
      gap_recovery_available: recovery,
      warnings,
    },
  };
}

/* ---------------------------------------------------------- D4 x402 gate */

async function stageX402Gate(config) {
  const gate = probeAllowed();
  if (!gate.allowed) {
    return {
      stage: "x402-gate",
      ok: true,
      code: "probe_rate_limited",
      message:
        `The unpaid payment probe has already run ${gate.recent_count} times in the last hour, so it was skipped to avoid ` +
        "tripping the service's rate limiter. Rerun with --force after the window resets.",
      retry_after_sec: gate.retry_after_sec,
      warnings: [{ code: "probe_rate_limited", message: "Payment gate not re-verified this run; the cached verdict stands." }],
    };
  }

  const url = apiUrl(config, "/socket/session");
  let probe;
  try {
    probe = await probePaymentGate(url, { method: "POST", body: {} });
  } catch (err) {
    return failStage("x402-gate", "service_not_ready",
      `The paid session route did not respond: ${err.message}`,
      "No payment was attempted. Retry once the service is reachable.");
  }

  if (probe.status !== 402) {
    return failStage("x402-gate", "service_not_ready",
      `POST /socket/session returned ${probe.status} instead of 402, so its payment terms could not be verified.`,
      "The paid socket route is not behaving as documented. Do not attempt payment; contact the operator.");
  }

  const parsed = parsePaymentRequired(probe.header);
  if (!parsed.ok) {
    return failStage("x402-gate", parsed.code, parsed.message,
      "The 402 response carried no usable payment terms. No payment was attempted.");
  }

  const { mismatches, amount } = validateRequirement(parsed.requirement, config, url, parsed.resource, parsed.version);
  if (mismatches.length) {
    return failStage("x402-gate", "payment_requirements_rejected",
      `The server's payment terms differ from local safety policy: ${mismatches
        .map((m) => `${m.field} is ${m.actual} (expected ${m.expected})`)
        .join("; ")}.`,
      "Refusing to sign. Confirm the official service configuration before changing any public pin.");
  }

  return {
    stage: "x402-gate",
    ok: true,
    code: "ok",
    resource: parsed.resource,
    scheme: parsed.requirement.scheme,
    network: parsed.requirement.network,
    asset: parsed.requirement.asset,
    pay_to: String(parsed.requirement.payTo).toLowerCase(),
    amount_usd: formatDollars(amount),
    max_timeout_seconds: parsed.requirement.maxTimeoutSeconds ?? CONTRACT.maxTimeoutSeconds,
    probes_this_hour: gate.recent_count + 1,
  };
}

/* --------------------------------------------------------- D5 dry-run pay */

async function stageDryRun(config) {
  const url = apiUrl(config, "/socket/session");
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  if (response.status !== 402) {
    return failStage("dry-run-payment", "service_not_ready",
      `Expected a 402 from ${url}, got ${response.status}.`,
      "No payment was attempted.");
  }
  const parsed = parsePaymentRequired(response.headers.get("payment-required"));
  if (!parsed.ok) {
    return failStage("dry-run-payment", parsed.code, parsed.message, "No payment was attempted.");
  }
  const { mismatches, amount } = validateRequirement(parsed.requirement, config, url, parsed.resource, parsed.version);
  if (mismatches.length) {
    return failStage("dry-run-payment", "payment_requirements_rejected",
      `The buyer would refuse this request: ${mismatches.map((m) => m.field).join(", ")} outside policy.`,
      "Refusing to sign. Confirm the official service configuration before changing any public pin.");
  }

  const ledger = ledgerSummary(config.dailyLimitAtomic);
  if (BigInt(ledger.remaining_atomic) < amount) {
    return failStage("dry-run-payment", "daily_spend_cap_reached",
      `Today's remaining budget is ${formatDollars(BigInt(ledger.remaining_atomic))}, less than the ${formatDollars(amount)} this call costs.`,
      `Report the spend and reset time (${ledger.resets_at}). The user raises X402_DAILY_LIMIT_ATOMIC themselves if they choose to.`);
  }

  return {
    stage: "dry-run-payment",
    ok: true,
    code: "ok",
    would_sign: true,
    amount_usd: formatDollars(amount),
    pay_to: String(parsed.requirement.payTo).toLowerCase(),
    cdp_account_name: config.accountName,
    remaining_budget_usd: formatDollars(BigInt(ledger.remaining_atomic)),
    note: "Nothing was signed and no wallet call was made.",
  };
}

/* ------------------------------------------------------------- D6 notify */

function resolveExecutable(command) {
  const first = command.trim().split(/\s+/)[0];
  const candidate = first.startsWith("scripts/") || first.startsWith("./scripts/")
    ? path.join(SKILL_ROOT, first.replace(/^\.\//, ""))
    : first;

  if (candidate.includes("/")) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { found: true, path: candidate };
    } catch {
      return { found: false, path: candidate, reason: "not found or not executable" };
    }
  }

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, candidate);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return { found: true, path: full };
    } catch {
      /* keep looking */
    }
  }
  return { found: false, path: candidate, reason: "not on PATH" };
}

async function stageNotify(config) {
  const warnings = [];
  let spool;
  try {
    ensureStateDir();
    spool = spoolStats();
  } catch (err) {
    return failStage("notify", "state_dir_unwritable",
      `The signal spool is not writable: ${err.message}`,
      "Fix the state directory before starting the supervisor; otherwise signals cannot be stored.");
  }

  if (!config.notifyCmd) {
    return {
      stage: "notify",
      ok: true,
      code: "notify_not_configured",
      message:
        "No WATCHTRENDS_NOTIFY_CMD is set. Signals will be spooled to disk but nothing will be pushed to the user.",
      spool,
      warnings: [
        {
          code: "notify_not_configured",
          message:
            "Tell the user plainly that without a notification channel they will only see signals when they next ask the agent. " +
            "references/notifications.md walks through the Telegram setup.",
        },
      ],
    };
  }

  const notifier = new Notifier(config);
  const resolved = resolveExecutable(notifier.resolvedCommand());
  if (!resolved.found) {
    return failStage("notify", "notify_command_failed",
      `WATCHTRENDS_NOTIFY_CMD starts with "${resolved.path}", which is ${resolved.reason}.`,
      "Fix the notify command path, then rerun 'doctor.mjs --notify'. No message was sent.");
  }

  const usesTelegram = notifier.resolvedCommand().includes("notify-telegram");
  const telegram = { used: usesTelegram };
  if (usesTelegram) {
    telegram.bot_token_set = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    telegram.chat_id_set = Boolean(process.env.TELEGRAM_CHAT_ID);
    if (!telegram.bot_token_set || !telegram.chat_id_set) {
      return failStage("notify", "notify_command_failed",
        `The Telegram notifier is selected but ${!telegram.bot_token_set ? "TELEGRAM_BOT_TOKEN" : "TELEGRAM_CHAT_ID"} is not set.`,
        "Point the user at references/notifications.md to create a bot and find their chat id, then have them set both variables in their secret store. Never ask for the token in chat.");
    }
    // getMe authenticates the token without sending anyone a message.
    try {
      const response = await fetchWithTimeout(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`,
        { headers: { Accept: "application/json" } },
        10_000
      );
      const body = await response.json().catch(() => ({}));
      telegram.authenticated = Boolean(body?.ok);
      telegram.bot_username = body?.result?.username ?? null;
      if (!telegram.authenticated) {
        return failStage("notify", "notify_command_failed",
          "Telegram rejected the bot token. The token value was not logged.",
          "Ask the user to re-check TELEGRAM_BOT_TOKEN in their secret store against the value BotFather gave them. Never ask them to paste it into chat.");
      }
    } catch (err) {
      warnings.push({
        code: "notify_check_incomplete",
        message: `Could not reach Telegram to verify the token: ${err.message}. The notifier may still work.`,
      });
    }
  }

  return {
    stage: "notify",
    ok: true,
    code: "ok",
    command_resolves_to: resolved.path,
    format: config.notifyFormat === "json" ? "json" : "text",
    telegram,
    spool,
    note: "No notification was sent by this check.",
    warnings,
  };
}

function failStage(stage, code, message, nextAction) {
  return { stage, ok: false, code, message, next_action: nextAction };
}
