#!/usr/bin/env node
/**
 * Cost projection. Spends nothing and touches no network.
 *
 * Run this BEFORE the first payment and show the user the dollar figure. The
 * point is that watching is a recurring charge; a user who is told "$0.01 per
 * watch" and then spends a dollar a day was misled.
 *
 * Usage: node scripts/budget-plan.mjs [tickers] [hours]
 */

import { loadConfig } from "./lib/config.mjs";
import { hoursAffordable, projectRun } from "./lib/costs.mjs";
import { emit, formatDollars, run } from "./lib/output.mjs";

const STAGE = "budget-plan";

run(STAGE, async () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const tickers = Math.max(1, Number.parseInt(args[0] ?? "1", 10) || 1);
  const hours = Math.max(1, Number.parseFloat(args[1] ?? "24") || 24);

  const config = loadConfig();
  const projection = projectRun(tickers, hours);
  const capCoversRun = projection.totalAtomic <= config.dailyLimitAtomic;
  const affordableHours = capCoversRun ? hours : hoursAffordable(config.dailyLimitAtomic, tickers, hours);

  const warnings = [];
  if (!capCoversRun) {
    warnings.push({
      code: "daily_cap_below_projection",
      message:
        `At your current cap of ${formatDollars(config.dailyLimitAtomic)} this run stops after about ` +
        `${affordableHours.toFixed(1)} hours. To cover the full ${hours} hours, set ` +
        `X402_DAILY_LIMIT_ATOMIC=${projection.recommendedCapAtomic.toString()} in your secret store. ` +
        "I will not change it for you.",
    });
  }

  emit({
    ok: true,
    stage: STAGE,
    code: warnings.length ? "daily_cap_below_projection" : "ok",
    request: { tickers, hours },
    projected: {
      total_atomic: projection.totalAtomic.toString(),
      total_usd: formatDollars(projection.totalAtomic),
      per_day_usd: formatDollars(projection.steadyDayAtomic),
      charges: projection.counts,
      cadence: projection.cadence,
    },
    cap: {
      configured_atomic: config.dailyLimitAtomic.toString(),
      configured_usd: formatDollars(config.dailyLimitAtomic),
      covers_full_run: capCoversRun,
      hours_affordable: Number(affordableHours.toFixed(2)),
      recommended_atomic: projection.recommendedCapAtomic.toString(),
      recommended_usd: formatDollars(projection.recommendedCapAtomic),
      note:
        "The shipped default is a runaway ceiling, not a budget. Lowering it to the recommended value " +
        "is the tighter setting; the agent never raises it for you.",
    },
    funding: {
      suggested_atomic: projection.weekFundingAtomic.toString(),
      suggested_usd: formatDollars(projection.weekFundingAtomic),
      note:
        "Fund the dedicated buyer wallet with about one week of spend and nothing else. " +
        "That balance, not the daily cap, is what actually limits total loss if something goes wrong.",
    },
    first_charges: projection.schedule.slice(0, 6).map((e) => ({
      at_minute: e.minute,
      kind: e.kind,
      count: e.count,
      usd: formatDollars(e.atomic),
    })),
    warnings,
    next_action:
      `Tell the user this run is projected to cost ${formatDollars(projection.totalAtomic)} ` +
      `(${formatDollars(projection.steadyDayAtomic)} per day if left running) and get explicit consent before paying.`,
  });
});
