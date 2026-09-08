/**
 * Notification dispatch.
 *
 * The message goes to the hook on STDIN, never in argv. Signal content is
 * remote-controlled data: putting it on a command line would both expose it to
 * anyone running `ps` and hand an attacker a shell-injection surface. Only the
 * user-authored command string is ever seen by the shell.
 *
 * A broken notifier must never cost the user their paid session, so every
 * failure here is contained: bounded retries, a hard timeout, and no throw.
 */

import { spawn } from "node:child_process";
import path from "node:path";

import { NOTIFY_MAX_ATTEMPTS, NOTIFY_TIMEOUT_MS } from "./constants.mjs";
import { SKILL_ROOT } from "./config.mjs";

/**
 * Render a signal as one short, actionable line followed by the service
 * disclosure verbatim. The disclosure is never summarised away.
 */
export function formatSignal({ ticker, payload, disclosure, receivedAt }) {
  const parts = [];
  const symbol = ticker || payload?.ticker || "unknown";
  const direction = payload?.direction || payload?.kind || payload?.event || "signal";
  const price = payload?.price ?? payload?.last_price ?? payload?.current_price;
  const threshold = payload?.threshold ?? payload?.threshold_pct;
  const change = payload?.change_pct ?? payload?.pct_change ?? payload?.move_pct;

  let headline = `watch-trends: ${symbol} ${direction}`;
  if (change !== undefined && change !== null) headline += ` ${change}%`;
  if (threshold !== undefined && threshold !== null) headline += ` (threshold ${threshold})`;
  if (price !== undefined && price !== null) headline += ` at ${price}`;
  parts.push(headline);
  parts.push(`time: ${receivedAt || new Date().toISOString()}`);

  const disclosureText =
    typeof disclosure === "string"
      ? disclosure
      : disclosure?.text || disclosure?.message || disclosure?.disclaimer || null;
  if (disclosureText) {
    parts.push("");
    parts.push(disclosureText);
  } else {
    parts.push("");
    parts.push("Informational only. Not investment advice.");
  }
  return parts.join("\n");
}

function runOnce(command, input, env) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd: SKILL_ROOT,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ ok: false, error: `could not start notify command: ${err.message}` });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: `notify command timed out after ${NOTIFY_TIMEOUT_MS}ms` });
    }, NOTIFY_TIMEOUT_MS);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.stdout.on("data", () => {
      /* drained so the child does not block on a full pipe */
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `notify command failed to run: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: `notify command exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}` });
    });

    child.stdin.on("error", () => {
      /* the child may exit before reading stdin; the exit code is the verdict */
    });
    child.stdin.end(input);
  });
}

/**
 * Serialized dispatcher. A burst of signals must not fork a process per signal
 * simultaneously, and must not stall the socket read loop, so sends are queued
 * and awaited off the hot path.
 */
export class Notifier {
  constructor(config, { onResult } = {}) {
    this.command = config.notifyCmd;
    this.format = config.notifyFormat === "json" ? "json" : "text";
    this.queue = Promise.resolve();
    this.onResult = onResult || (() => {});
    this.configured = Boolean(this.command);
  }

  /** Resolve a bare script name against the skill directory for convenience. */
  resolvedCommand() {
    if (!this.command) return null;
    const trimmed = this.command.trim();
    if (trimmed.startsWith("scripts/") || trimmed.startsWith("./scripts/")) {
      const [first, ...rest] = trimmed.split(/\s+/);
      return [path.join(SKILL_ROOT, first.replace(/^\.\//, "")), ...rest].join(" ");
    }
    return trimmed;
  }

  enqueue(signal) {
    if (!this.configured) {
      this.onResult({ event_id: signal.eventId, notified: false, error: "notify_not_configured" });
      return;
    }
    this.queue = this.queue.then(() => this.#deliver(signal)).catch(() => {});
  }

  async #deliver(signal) {
    const body =
      this.format === "json"
        ? JSON.stringify({
            event_id: signal.eventId,
            ticker: signal.ticker,
            received_at: signal.receivedAt,
            payload: signal.payload,
            disclosure: signal.disclosure,
          })
        : formatSignal(signal);

    const command = this.resolvedCommand();
    let last = { ok: false, error: "not attempted" };
    for (let attempt = 1; attempt <= NOTIFY_MAX_ATTEMPTS; attempt += 1) {
      last = await runOnce(command, body, process.env);
      if (last.ok) {
        this.onResult({ event_id: signal.eventId, notified: true, attempts: attempt });
        return;
      }
      if (attempt < NOTIFY_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
    this.onResult({
      event_id: signal.eventId,
      notified: false,
      attempts: NOTIFY_MAX_ATTEMPTS,
      error: last.error,
      code: "notify_command_failed",
    });
  }

  /** Wait for the queue to drain, used on graceful shutdown. */
  async drain() {
    await this.queue;
  }
}
