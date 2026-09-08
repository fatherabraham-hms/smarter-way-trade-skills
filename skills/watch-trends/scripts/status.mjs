#!/usr/bin/env node
/**
 * Spend, session, and signal report. Spends nothing and touches no network.
 *
 * Run this at the start of any conversation about watches. The supervisor runs
 * detached, so a stopped stream, an exhausted cap, or a signal that arrived
 * while the chat was closed are all invisible until something asks.
 *
 * Usage:
 *   node scripts/status.mjs
 *   node scripts/status.mjs --signals [--since <iso|event_id>] [--limit 20]
 */

import fs from "node:fs";

import { loadConfig, statePath } from "./lib/config.mjs";
import { inspect as inspectLock } from "./lib/lock.mjs";
import { summary as ledgerSummary } from "./lib/ledger.mjs";
import { projectRun } from "./lib/costs.mjs";
import { list as listWatches } from "./lib/watches.mjs";
import { readSignals, spoolStats } from "./lib/spool.mjs";
import { emit, formatDollars, run } from "./lib/output.mjs";

const STAGE = "status";
const LOCK_STALE_MS = 90_000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

run(STAGE, async () => {
  const argv = process.argv.slice(2);
  const wantSignals = argv.includes("--signals");
  const sinceIndex = argv.indexOf("--since");
  const since = sinceIndex >= 0 ? argv[sinceIndex + 1] : null;
  const limitIndex = argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number.parseInt(argv[limitIndex + 1], 10) || 20 : 20;

  const config = loadConfig();
  const ledger = ledgerSummary(config.dailyLimitAtomic);
  const lock = inspectLock(statePath("session.lock"), { staleMs: LOCK_STALE_MS });
  const supervisorStatus = readJson(statePath("supervisor-status.json"));
  const sessionMeta = readJson(statePath("session.json"));
  const watches = listWatches();

  const alerts = [];

  if (!lock.held) {
    alerts.push({
      code: "supervisor_not_running",
      message:
        "No signal session is running, so nothing is being delivered right now. " +
        (supervisorStatus
          ? `The last supervisor heartbeat was ${supervisorStatus.ts}.`
          : "There is no record of a previous run."),
    });
  }

  if (sessionMeta?.expires_at && Date.parse(sessionMeta.expires_at) > Date.now() && !lock.held) {
    const minutes = Math.round((Date.parse(sessionMeta.expires_at) - Date.now()) / 60_000);
    alerts.push({
      code: "session_token_lost",
      message:
        `A paid socket session is still valid for about ${minutes} more minute(s), but the supervisor that owned its ` +
        "token is gone. That charge cannot be recovered; starting again buys a new session.",
    });
  }

  if (BigInt(ledger.remaining_atomic) === 0n) {
    alerts.push({
      code: "daily_spend_cap_reached",
      message: `Today's spend cap is used up. The budget window resets at ${ledger.resets_at}.`,
    });
  } else if (ledger.used_fraction >= 0.8) {
    alerts.push({
      code: "daily_spend_warning",
      message: `${Math.round(ledger.used_fraction * 100)}% of today's cap is used (${formatDollars(BigInt(ledger.spent_atomic))} of ${formatDollars(BigInt(ledger.cap_atomic))}).`,
    });
  }

  for (const watch of watches) {
    const remaining = watch.expires_at ? Date.parse(watch.expires_at) - Date.now() : null;
    if (remaining !== null && remaining <= 0) {
      alerts.push({
        code: "lease_expired",
        message: `The lease for ${watch.ticker} expired at ${watch.expires_at}; it is no longer producing signals.`,
      });
    }
  }

  const unnotified = readSignals({ limit: 200 }).filter((s) => s.notified === false);
  if (unnotified.length) {
    alerts.push({
      code: "notify_command_failed",
      message: `${unnotified.length} spooled signal(s) were never delivered to a notification channel. They are readable with --signals.`,
    });
  }

  const projection = projectRun(Math.max(1, watches.length), 24);

  const result = {
    ok: true,
    stage: STAGE,
    code: alerts.length ? alerts[0].code : "ok",
    supervisor: {
      running: lock.held,
      pid: lock.held ? lock.pid : null,
      last_heartbeat: lock.heartbeat_at ?? null,
      last_status: supervisorStatus,
    },
    session: sessionMeta
      ? { expires_at: sessionMeta.expires_at, ws_host: sessionMeta.ws_host, tx_prefix: sessionMeta.tx_prefix }
      : null,
    watches: watches.map((w) => ({
      ticker: w.ticker,
      segment: w.segment,
      threshold: w.threshold,
      expires_at: w.expires_at,
      renewals: w.renewals,
      minutes_remaining: w.expires_at ? Math.round((Date.parse(w.expires_at) - Date.now()) / 60_000) : null,
    })),
    spend: {
      date: ledger.date,
      spent_today_usd: formatDollars(BigInt(ledger.spent_atomic)),
      in_flight_usd: formatDollars(BigInt(ledger.pending_atomic)),
      cap_usd: formatDollars(BigInt(ledger.cap_atomic)),
      remaining_usd: formatDollars(BigInt(ledger.remaining_atomic)),
      resets_at: ledger.resets_at,
      projected_per_day_usd: formatDollars(projection.steadyDayAtomic),
      recent_charges: ledger.entries.slice(-10),
    },
    notifications: {
      configured: Boolean(config.notifyCmd),
      command: config.notifyCmd ?? null,
      spool: spoolStats(),
      undelivered: unnotified.length,
    },
    alerts,
    next_action: alerts.length
      ? `Report this to the user first: ${alerts[0].message}`
      : "Everything is running. Report spend and next scheduled charge if the user asks.",
  };

  if (wantSignals) {
    result.signals = readSignals({ since, limit }).map((s) => ({
      event_id: s.event_id,
      received_at: s.received_at,
      ticker: s.ticker,
      source: s.source,
      notified: s.notified,
      payload: s.payload,
      disclosure: s.disclosure,
    }));
  }

  emit(result);
});
