#!/usr/bin/env node
/**
 * Guarded x402 buyer CLI.
 *
 * Every guardrail is fail-closed: an unexpected payee, network, asset, amount,
 * or resource means no signature at all, rather than a signature plus a
 * warning. --dry-run stops before the wallet is ever touched.
 *
 * Usage:
 *   node scripts/x402-pay-request.mjs [--dry-run] <METHOD> <url> ['<json body>']
 */

import { loadConfig } from "./lib/config.mjs";
import { SkillError } from "./lib/cdp.mjs";
import { emit, formatDollars, run } from "./lib/output.mjs";
import { failIfNotReady } from "./lib/ready.mjs";
import { payRequest } from "./lib/x402.mjs";

const STAGE = "buyer";

run(STAGE, async () => {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const args = argv.filter((a) => a !== "--dry-run");
  const method = (args[0] || "POST").toUpperCase();
  const url = args[1];
  const bodyRaw = args[2] || "{}";

  if (!url) {
    emit({
      ok: false,
      stage: STAGE,
      code: "usage",
      message: "Usage: x402-pay-request.mjs [--dry-run] <METHOD> <url> ['<json body>']",
    });
    process.exit(2);
  }

  let body;
  try {
    body = JSON.parse(bodyRaw);
  } catch {
    emit({ ok: false, stage: STAGE, code: "invalid_body", message: "The request body must be valid JSON." });
    process.exit(2);
  }

  failIfNotReady(STAGE, { requireCredentials: !dryRun });

  const config = loadConfig();

  try {
    const result = await payRequest({ method, url, body, config, dryRun, route: `${method} ${new URL(url).pathname}` });
    emit({
      ...result,
      stage: STAGE,
      code: result.code || (result.ok ? "ok" : "request_rejected"),
      amount_usd: result.amount_atomic ? formatDollars(BigInt(result.amount_atomic)) : undefined,
      would_pay_usd: result.would_pay_atomic ? formatDollars(BigInt(result.would_pay_atomic)) : undefined,
    });
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    if (err instanceof SkillError) {
      emit({
        ok: false,
        stage: STAGE,
        code: err.code,
        message: err.message,
        ...err.extra,
        next_action: nextActionFor(err.code),
      });
      process.exit(1);
    }
    throw err;
  }
});

function nextActionFor(code) {
  switch (code) {
    case "payment_requirements_rejected":
      return "Show the mismatched field. Do not change a safety pin until the operator confirms the official service configuration.";
    case "daily_spend_cap_reached":
      return "Report today's spend and the reset time. The user changes X402_DAILY_LIMIT_ATOMIC themselves; never raise it for them.";
    case "cdp_credentials_missing":
      return "Name the missing variables and point to references/security.md. Never ask for the values in chat.";
    case "shared_wallet_refused":
      return "Explain that automated spending should use a dedicated small-balance wallet. Do not set the override flag yourself.";
    case "deps_not_installed":
      return "Run npm ci inside the skill directory and try again.";
    default:
      return "Report the diagnostic code to the user; no further spend was attempted.";
  }
}
