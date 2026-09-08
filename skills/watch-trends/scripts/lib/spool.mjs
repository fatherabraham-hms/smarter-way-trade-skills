/**
 * Durable signal spool.
 *
 * Every validated signal lands here before anything else is attempted, so a
 * misconfigured notifier can never turn a paid-for signal into a lost one.
 *
 * The file is append-only JSONL. Delivery status arrives later than the signal
 * itself, so it is recorded as a separate `amend` line rather than by rewriting
 * history; a crash mid-notify therefore cannot corrupt an earlier entry.
 */

import fs from "node:fs";

import { SPOOL_MAX_BYTES, SPOOL_MAX_ENTRIES } from "./constants.mjs";
import { ensureStateDir, statePath } from "./config.mjs";

function spoolFile() {
  return statePath("signals.jsonl");
}

function rotatedFile() {
  return statePath("signals.1.jsonl");
}

function appendLine(obj) {
  ensureStateDir();
  fs.appendFileSync(spoolFile(), `${JSON.stringify(obj)}\n`, { mode: 0o600 });
}

function readLines(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(spoolFile());
    if (stat.size < SPOOL_MAX_BYTES) {
      const count = readLines(spoolFile()).length;
      if (count < SPOOL_MAX_ENTRIES) return false;
    }
    fs.renameSync(spoolFile(), rotatedFile());
    return true;
  } catch {
    return false;
  }
}

/**
 * Event ids already spooled, used to drop duplicates when gap recovery replays
 * signals the socket already delivered.
 */
export function knownEventIds(limit = SPOOL_MAX_ENTRIES) {
  const ids = new Set();
  for (const entry of [...readLines(rotatedFile()), ...readLines(spoolFile())].slice(-limit)) {
    if (entry.type === "signal" && entry.event_id) ids.add(entry.event_id);
  }
  return ids;
}

/**
 * Append a signal. Returns false when the event was already spooled, which the
 * caller uses to suppress a duplicate notification.
 */
export function appendSignal({ eventId, ticker, payload, disclosure, source = "socket" }) {
  const id = eventId || deriveEventId(payload, ticker);
  if (knownEventIds().has(id)) return { appended: false, event_id: id };
  rotateIfNeeded();
  appendLine({
    type: "signal",
    event_id: id,
    received_at: new Date().toISOString(),
    ticker: ticker ?? null,
    source,
    payload,
    disclosure: disclosure ?? null,
    notified: false,
  });
  return { appended: true, event_id: id };
}

/** Record the outcome of the notify hook for a spooled signal. */
export function amendNotified(eventId, notified, error = null) {
  appendLine({
    type: "amend",
    event_id: eventId,
    amended_at: new Date().toISOString(),
    notified,
    notify_error: error,
  });
}

/**
 * Stable id for services that do not supply one, so replays still deduplicate.
 * Hashing the payload is enough because an identical payload at an identical
 * timestamp is the same event.
 */
export function deriveEventId(payload, ticker) {
  const basis = JSON.stringify({
    ticker: ticker ?? payload?.ticker ?? null,
    ts: payload?.ts ?? payload?.timestamp ?? payload?.detected_at ?? null,
    price: payload?.price ?? null,
    kind: payload?.kind ?? payload?.direction ?? payload?.event ?? null,
  });
  let hash = 0;
  for (let i = 0; i < basis.length; i += 1) {
    hash = (hash * 31 + basis.charCodeAt(i)) | 0;
  }
  return `derived-${(hash >>> 0).toString(16)}`;
}

/**
 * Read spooled signals with amendments folded in.
 * `since` accepts an ISO timestamp or an event id.
 */
export function readSignals({ since = null, limit = 50 } = {}) {
  const all = [...readLines(rotatedFile()), ...readLines(spoolFile())];
  const signals = new Map();
  for (const entry of all) {
    if (entry.type === "signal") {
      signals.set(entry.event_id, { ...entry });
    } else if (entry.type === "amend" && signals.has(entry.event_id)) {
      const existing = signals.get(entry.event_id);
      existing.notified = entry.notified;
      existing.notify_error = entry.notify_error ?? null;
    }
  }

  let list = [...signals.values()];
  if (since) {
    const sinceMs = Date.parse(since);
    if (Number.isFinite(sinceMs)) {
      list = list.filter((s) => Date.parse(s.received_at) > sinceMs);
    } else {
      const index = list.findIndex((s) => s.event_id === since);
      if (index >= 0) list = list.slice(index + 1);
    }
  }
  return list.slice(-limit);
}

export function spoolStats() {
  const all = [...readLines(rotatedFile()), ...readLines(spoolFile())];
  const signals = all.filter((e) => e.type === "signal");
  let size = 0;
  try {
    size = fs.statSync(spoolFile()).size;
  } catch {
    /* no spool yet */
  }
  return {
    path: spoolFile(),
    bytes: size,
    total_signals: signals.length,
    last_received_at: signals.length ? signals[signals.length - 1].received_at : null,
  };
}
