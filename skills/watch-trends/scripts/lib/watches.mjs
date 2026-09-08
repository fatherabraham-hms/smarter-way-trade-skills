/**
 * Local record of active watches and their lease expiry.
 *
 * The supervisor has to know when each lease expires in order to renew on
 * time. Asking the service costs money (GET /watches is a paid route), so the
 * start and renew scripts record what they already learned for free.
 *
 * This file is a cache, never an authority: if it is missing or stale the
 * supervisor renews conservatively rather than assuming a lease is still live.
 */

import fs from "node:fs";

import { CONTRACT } from "./constants.mjs";
import { ensureStateDir, statePath } from "./config.mjs";

function file() {
  return statePath("watches.json");
}

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  ensureStateDir();
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/**
 * Pull an expiry out of a service response, falling back to the documented
 * lease window when the response does not state one.
 */
export function expiryFromResponse(body, fallbackFrom = Date.now()) {
  const candidates = [
    body?.expires_at,
    body?.lease_expires_at,
    body?.watch?.expires_at,
    body?.expiry,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const minutes = Number(body?.ttl_minutes ?? body?.window_minutes ?? CONTRACT.leaseWindowMinutes);
  const window = Number.isFinite(minutes) && minutes > 0 ? minutes : CONTRACT.leaseWindowMinutes;
  return new Date(fallbackFrom + window * 60_000).toISOString();
}

export function recordStart(ticker, { segment, threshold, startPrice, expiresAt, assetType }) {
  const all = readAll();
  all[ticker.toUpperCase()] = {
    ticker: ticker.toUpperCase(),
    segment,
    threshold,
    start_price: startPrice,
    asset_type: assetType ?? null,
    started_at: new Date().toISOString(),
    expires_at: expiresAt,
    renewals: 0,
  };
  writeAll(all);
  return all[ticker.toUpperCase()];
}

export function recordRenew(ticker, expiresAt) {
  const all = readAll();
  const key = ticker.toUpperCase();
  const existing = all[key] || { ticker: key, started_at: new Date().toISOString(), renewals: 0 };
  all[key] = {
    ...existing,
    expires_at: expiresAt,
    renewals: (existing.renewals || 0) + 1,
    last_renewed_at: new Date().toISOString(),
  };
  writeAll(all);
  return all[key];
}

export function recordStop(ticker) {
  const all = readAll();
  delete all[ticker.toUpperCase()];
  writeAll(all);
}

export function get(ticker) {
  return readAll()[ticker.toUpperCase()] || null;
}

export function list() {
  return Object.values(readAll());
}

/** Milliseconds until the lease expires, or null when the expiry is unknown. */
export function msUntilExpiry(ticker) {
  const record = get(ticker);
  if (!record?.expires_at) return null;
  const ms = Date.parse(record.expires_at);
  if (!Number.isFinite(ms)) return null;
  return ms - Date.now();
}
