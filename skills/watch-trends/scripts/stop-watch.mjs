#!/usr/bin/env node
/**
 * Paid DELETE /watches/{ticker}. Costs $0.01.
 *
 * Teardown is a paid call, so stopping a watch has a price. Letting the lease
 * lapse is free but leaves it running for up to the remaining window; this
 * script is for stopping now.
 *
 * Usage: node scripts/stop-watch.mjs <ticker> [--dry-run]
 */

import { loadConfig } from "./lib/config.mjs";
import { SkillError } from "./lib/cdp.mjs";
import { PRICE_ATOMIC } from "./lib/constants.mjs";
import { emit, formatDollars, run } from "./lib/output.mjs";
import { failIfNotReady } from "./lib/ready.mjs";
import { stopWatch } from "./lib/watch-ops.mjs";

const STAGE = "stop-watch";

run(STAGE, async () => {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const ticker = argv.find((a) => !a.startsWith("--"));

  if (!ticker) {
    emit({ ok: false, stage: STAGE, code: "usage", message: "Usage: stop-watch.mjs <ticker> [--dry-run]" });
    process.exit(2);
  }

  failIfNotReady(STAGE, { requireCredentials: !dryRun });

  const config = loadConfig();
  try {
    const result = await stopWatch({ config, ticker, dryRun });
    emit({
      ...result,
      stage: STAGE,
      code: result.code || (result.ok ? "ok" : "request_rejected"),
      cost_usd: formatDollars(PRICE_ATOMIC.start),
      next_action: result.ok
        ? "The watch is stopped. Send SIGTERM to the supervisor as well if this was the last ticker, so it stops buying sessions."
        : result.message || "The watch was not stopped.",
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
