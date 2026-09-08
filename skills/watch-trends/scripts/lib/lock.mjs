/**
 * O_EXCL lockfiles with PID + heartbeat.
 *
 * Used for two different jobs:
 *   - budget.lock: a short mutex so two buyers cannot both pass the cap check
 *   - session.lock: a long-lived single-instance guard so two supervisors
 *     cannot both buy a socket session for the same wallet
 *
 * A crashed holder must not wedge the skill forever, so a lock is stealable
 * once its heartbeat goes stale or its PID is provably gone.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOSTNAME = os.hostname();

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A lock is stale when its heartbeat has lapsed, or when we can see the holder
 * is on this host and its PID is gone. A holder on another host can only be
 * judged by heartbeat.
 */
function isStale(info, staleMs) {
  if (!info) return true;
  const beat = Date.parse(info.heartbeat_at || info.acquired_at || 0);
  if (!Number.isFinite(beat)) return true;
  if (Date.now() - beat > staleMs) return true;
  if (info.host === HOSTNAME && !isProcessAlive(info.pid)) return true;
  return false;
}

/**
 * Try to take a lock. Returns a handle on success, or {ok:false, holder} when
 * a live holder owns it. Never blocks forever.
 */
export function tryAcquire(file, { staleMs = 60_000, label = "lock" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = () =>
    JSON.stringify({
      pid: process.pid,
      host: HOSTNAME,
      label,
      acquired_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, payload());
      fs.closeSync(fd);
      return makeHandle(file, label);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const holder = readLock(file);
      if (!isStale(holder, staleMs)) {
        return { ok: false, holder: holder ? { pid: holder.pid, host: holder.host, acquired_at: holder.acquired_at } : null };
      }
      // Stale: remove and retry once. A racing steal loses the second open.
      try {
        fs.unlinkSync(file);
      } catch {
        /* another process already cleaned it up */
      }
    }
  }
  const holder = readLock(file);
  return { ok: false, holder: holder ? { pid: holder.pid, host: holder.host, acquired_at: holder.acquired_at } : null };
}

function makeHandle(file, label) {
  let released = false;
  return {
    ok: true,
    file,
    heartbeat() {
      if (released) return;
      try {
        const info = readLock(file) || { pid: process.pid, host: HOSTNAME, label };
        if (info.pid !== process.pid || info.host !== HOSTNAME) return; // someone stole it
        info.heartbeat_at = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
      } catch {
        /* heartbeat is best effort; staleness handles the rest */
      }
    },
    /** True while this process still owns the file it created. */
    stillOwned() {
      const info = readLock(file);
      return Boolean(info && info.pid === process.pid && info.host === HOSTNAME);
    },
    release() {
      if (released) return;
      released = true;
      try {
        const info = readLock(file);
        if (!info || (info.pid === process.pid && info.host === HOSTNAME)) fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Acquire with bounded retries. Used for the budget mutex, where waiting a
 * moment is far better than failing a payment path.
 */
export async function acquireWithRetry(file, { staleMs = 60_000, timeoutMs = 5_000, label = "lock" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = tryAcquire(file, { staleMs, label });
    if (last.ok) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 75));
  }
}

/** Read a lock's holder without taking it. */
export function inspect(file, { staleMs = 60_000 } = {}) {
  const info = readLock(file);
  if (!info) return { held: false };
  return {
    held: !isStale(info, staleMs),
    pid: info.pid,
    host: info.host,
    acquired_at: info.acquired_at,
    heartbeat_at: info.heartbeat_at,
    stale: isStale(info, staleMs),
  };
}
