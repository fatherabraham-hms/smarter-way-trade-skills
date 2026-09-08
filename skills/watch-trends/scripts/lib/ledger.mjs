/**
 * Daily spend ledger.
 *
 * The cap is checked and debited BEFORE signing, then reconciled after the
 * server responds. Reserving first is what makes concurrent buyers safe: two
 * processes cannot both read "under the cap" and then both spend, because the
 * reservation happens under an exclusive lock.
 *
 * A reservation that is never committed is rolled back, so a refused payment
 * does not permanently consume budget.
 */

import fs from "node:fs";
import crypto from "node:crypto";

import { statePath, ensureStateDir } from "./config.mjs";
import { acquireWithRetry } from "./lock.mjs";

const MAX_ENTRIES = 500;
const LOCK_STALE_MS = 30_000;

function ledgerFile() {
  return statePath("budget.json");
}

function lockFile() {
  return statePath("budget.lock");
}

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Start of the next UTC day: when the budget window resets. */
export function nextResetIso(date = new Date()) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return next.toISOString();
}

function emptyLedger() {
  return { date: utcDay(), spent_atomic: "0", reservations: {}, entries: [] };
}

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(), "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyLedger();
    return {
      date: parsed.date || utcDay(),
      spent_atomic: String(parsed.spent_atomic ?? "0"),
      reservations: parsed.reservations && typeof parsed.reservations === "object" ? parsed.reservations : {},
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return emptyLedger();
  }
}

/** Roll the ledger over at UTC midnight, preserving history for the report. */
function withRollover(raw) {
  const today = utcDay();
  if (raw.date === today) return raw;
  return {
    date: today,
    spent_atomic: "0",
    reservations: {},
    entries: raw.entries.slice(-MAX_ENTRIES),
  };
}

function writeRaw(raw) {
  ensureStateDir();
  const trimmed = { ...raw, entries: raw.entries.slice(-MAX_ENTRIES) };
  const tmp = `${ledgerFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ledgerFile());
}

/** Sum of outstanding reservations, which count against the cap. */
function pendingTotal(raw) {
  return Object.values(raw.reservations).reduce((sum, r) => sum + BigInt(r.atomic || "0"), 0n);
}

async function withLock(fn) {
  ensureStateDir();
  const handle = await acquireWithRetry(lockFile(), {
    staleMs: LOCK_STALE_MS,
    timeoutMs: 5_000,
    label: "budget",
  });
  if (!handle.ok) {
    return {
      ok: false,
      code: "budget_locked",
      message:
        "Could not take the spend-ledger lock. Another buyer is mid-payment; retry in a moment. " +
        "No payment was attempted.",
      holder: handle.holder,
    };
  }
  try {
    return await fn();
  } finally {
    handle.release();
  }
}

/**
 * Reserve budget for one call. Returns a reservation id that must be either
 * committed or rolled back.
 */
export async function reserve({ amountAtomic, route, dailyLimitAtomic }) {
  return withLock(async () => {
    const raw = withRollover(readRaw());
    const spent = BigInt(raw.spent_atomic);
    const pending = pendingTotal(raw);
    const projected = spent + pending + BigInt(amountAtomic);

    if (projected > BigInt(dailyLimitAtomic)) {
      writeRaw(raw);
      return {
        ok: false,
        code: "daily_spend_cap_reached",
        message:
          `This charge would take today's spend past your cap. ` +
          `Already committed: ${spent} atomic; in flight: ${pending}; this call: ${amountAtomic}; cap: ${dailyLimitAtomic}.`,
        spent_atomic: spent.toString(),
        pending_atomic: pending.toString(),
        cap_atomic: BigInt(dailyLimitAtomic).toString(),
        resets_at: nextResetIso(),
      };
    }

    const id = crypto.randomUUID();
    raw.reservations[id] = {
      atomic: BigInt(amountAtomic).toString(),
      route,
      created_at: new Date().toISOString(),
      pid: process.pid,
    };
    writeRaw(raw);
    return {
      ok: true,
      reservation_id: id,
      spent_atomic: spent.toString(),
      pending_atomic: (pending + BigInt(amountAtomic)).toString(),
      remaining_atomic: (BigInt(dailyLimitAtomic) - projected).toString(),
    };
  });
}

/** Convert a reservation into committed spend after the server settled it. */
export async function commit(reservationId, { txPrefix = null, status = "settled" } = {}) {
  return withLock(async () => {
    const raw = withRollover(readRaw());
    const reservation = raw.reservations[reservationId];
    if (!reservation) {
      // Rollover or an external cleanup removed it. Record the charge anyway so
      // the user's spend report stays truthful.
      raw.entries.push({
        ts: new Date().toISOString(),
        route: "unknown",
        atomic: "0",
        tx_prefix: txPrefix,
        status: "orphaned_commit",
      });
      writeRaw(raw);
      return { ok: true, orphaned: true };
    }
    delete raw.reservations[reservationId];
    raw.spent_atomic = (BigInt(raw.spent_atomic) + BigInt(reservation.atomic)).toString();
    raw.entries.push({
      ts: new Date().toISOString(),
      route: reservation.route,
      atomic: reservation.atomic,
      tx_prefix: txPrefix,
      status,
    });
    writeRaw(raw);
    return { ok: true, spent_atomic: raw.spent_atomic };
  });
}

/** Release a reservation whose payment never happened. */
export async function rollback(reservationId, reason = "not_attempted") {
  return withLock(async () => {
    const raw = withRollover(readRaw());
    if (raw.reservations[reservationId]) {
      const reservation = raw.reservations[reservationId];
      delete raw.reservations[reservationId];
      raw.entries.push({
        ts: new Date().toISOString(),
        route: reservation.route,
        atomic: "0",
        attempted_atomic: reservation.atomic,
        tx_prefix: null,
        status: `rolled_back:${reason}`,
      });
    }
    writeRaw(raw);
    return { ok: true };
  });
}

/** Drop reservations left behind by a crashed process. */
export async function reapStaleReservations(maxAgeMs = 5 * 60_000) {
  return withLock(async () => {
    const raw = withRollover(readRaw());
    let reaped = 0;
    for (const [id, reservation] of Object.entries(raw.reservations)) {
      const age = Date.now() - Date.parse(reservation.created_at || 0);
      if (!Number.isFinite(age) || age > maxAgeMs) {
        delete raw.reservations[id];
        reaped += 1;
      }
    }
    if (reaped) writeRaw(raw);
    return { ok: true, reaped };
  });
}

/** Non-mutating spend report. Safe to call from status and doctor. */
export function summary(dailyLimitAtomic) {
  const raw = withRollover(readRaw());
  const spent = BigInt(raw.spent_atomic);
  const pending = pendingTotal(raw);
  const cap = BigInt(dailyLimitAtomic);
  return {
    date: raw.date,
    spent_atomic: spent.toString(),
    pending_atomic: pending.toString(),
    cap_atomic: cap.toString(),
    remaining_atomic: (cap - spent - pending > 0n ? cap - spent - pending : 0n).toString(),
    used_fraction: cap > 0n ? Number((spent * 10000n) / cap) / 10000 : 0,
    resets_at: nextResetIso(),
    entries: raw.entries.slice(-50),
  };
}
