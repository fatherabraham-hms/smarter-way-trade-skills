#!/usr/bin/env node
/**
 * Paid POST /watches. Costs $0.01.
 *
 * The start price is mandatory and validated, because the threshold band is
 * computed from it: a mistyped price buys a watch that either never fires or
 * fires constantly, and the user pays either way.
 *
 * Usage:
 *   node scripts/start-watch.mjs <ticker> <segment> <threshold> --start-price <p>
 *        [--reference-price <p>] [--asset-type crypto|stock] [--confidence n] [--dry-run]
 */

import { loadConfig } from "./lib/config.mjs";
import { SkillError } from "./lib/cdp.mjs";
import { emit, formatDollars, run } from "./lib/output.mjs";
import { failIfNotReady } from "./lib/ready.mjs";
import { startWatch, validateStartPrice } from "./lib/watch-ops.mjs";
import { PRICE_ATOMIC } from "./lib/constants.mjs";

const STAGE = "start-watch";

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

run(STAGE, async () => {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      if (argv[i] !== "--dry-run") i += 1;
      continue;
    }
    positional.push(argv[i]);
  }

  const [ticker, segment, threshold] = positional;
  const startPrice = flag(argv, "--start-price");
  const referencePrice = flag(argv, "--reference-price");
  const assetType = flag(argv, "--asset-type");
  const confidence = flag(argv, "--confidence");

  if (!ticker || !segment || threshold === undefined || startPrice === null) {
    emit({
      ok: false,
      stage: STAGE,
      code: "usage",
      message:
        "Usage: start-watch.mjs <ticker> <segment> <threshold> --start-price <p> " +
        "[--reference-price <p>] [--asset-type crypto|stock] [--confidence n] [--dry-run]",
    });
    process.exit(2);
  }

  const priceCheck = validateStartPrice(startPrice, referencePrice);
  if (!priceCheck.ok) {
    emit({
      ok: false,
      stage: STAGE,
      code: priceCheck.code,
      message: priceCheck.message,
      next_action:
        "Re-confirm the current price with the user and echo the resulting threshold band back before paying. " +
        "No payment was attempted.",
    });
    process.exit(1);
  }

  failIfNotReady(STAGE, { requireCredentials: !dryRun });

  const config = loadConfig();

  try {
    const result = await startWatch({
      config,
      ticker,
      segment,
      threshold,
      startPrice: priceCheck.price,
      assetType,
      confidence,
      dryRun,
    });

    emit({
      ...result,
      stage: STAGE,
      code: result.code || (result.ok ? "ok" : "request_rejected"),
      cost_usd: formatDollars(PRICE_ATOMIC.start),
      next_action: result.ok
        ? `Watch is live until ${result.watch?.expires_at}. Start the supervisor so the lease is renewed and signals are delivered; ` +
          "without it the watch goes dead within the lease window."
        : result.message || "The watch was not created.",
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
