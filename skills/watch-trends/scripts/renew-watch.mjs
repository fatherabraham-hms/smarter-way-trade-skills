#!/usr/bin/env node
/**
 * Paid POST /watches/{ticker}/renew. Costs $0.01.
 *
 * Normally the supervisor does this on schedule; this script exists for manual
 * recovery when the supervisor was stopped and a lease is about to lapse.
 *
 * Usage: node scripts/renew-watch.mjs <ticker> [--dry-run]
 */

import { loadConfig } from "./lib/config.mjs";
import { SkillError } from "./lib/cdp.mjs";
import { PRICE_ATOMIC } from "./lib/constants.mjs";
import { emit, formatDollars, run } from "./lib/output.mjs";
import { failIfNotReady } from "./lib/ready.mjs";
import { renewWatch } from "./lib/watch-ops.mjs";

const STAGE = "renew-watch";

run(STAGE, async () => {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const ticker = argv.find((a) => !a.startsWith("--"));

  if (!ticker) {
    emit({ ok: false, stage: STAGE, code: "usage", message: "Usage: renew-watch.mjs <ticker> [--dry-run]" });
    process.exit(2);
  }

  failIfNotReady(STAGE, { requireCredentials: !dryRun });

  const config = loadConfig();
  try {
    const result = await renewWatch({ config, ticker, dryRun });
    emit({
      ...result,
      stage: STAGE,
      code: result.code || (result.ok ? "ok" : "request_rejected"),
      cost_usd: formatDollars(PRICE_ATOMIC.renew),
      next_action: result.ok
        ? `Lease extended to ${result.watch?.expires_at}.`
        : result.message || "The renewal was rejected.",
    });
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    if (err instanceof SkillError) {
      emit({ ok: false, stage: STAGE, code: err.code, message: err.message, ...err.extra });
      process.exit(1);
    }
    throw err;
  }
});
