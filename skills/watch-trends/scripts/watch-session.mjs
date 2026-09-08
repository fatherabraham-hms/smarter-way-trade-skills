#!/usr/bin/env node
/**
 * Session supervisor: the only supported way to run this skill continuously.
 *
 * The service expires both the watch lease and the socket session on a
 * 30-minute clock, so a setup with nobody minding it goes dead within half an
 * hour. This process owns that loop: it holds the socket, answers liveness
 * pings, renews leases before they lapse, re-buys the session before it
 * expires, reports every gap, and spools plus forwards every signal.
 *
 * It emits JSON Lines on stdout (one event per line) rather than a single
 * result object, because it is long-running. Every line has `event` and `ts`.
 *
 * Usage:
 *   node scripts/watch-session.mjs --ticker BTC [--ticker ETH] [--hours 24]
 *        [--accept-session-loss] [--no-recover-gaps] [--status-interval 300]
 */

import fs from "node:fs";

import WebSocket from "ws";

import {
  CLOSE_CODE_ACTIONS,
  CONTRACT,
  KNOWN_FRAME_TYPES,
  MIN_SECONDS_BETWEEN_PAID_SESSIONS,
  PRICE_ATOMIC,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_MIN_MS,
  RENEW_LEAD_SEC,
  SESSION_REBUY_LEAD_SEC,
  SPEND_ANOMALY_STOP_MULTIPLE,
  SPEND_ANOMALY_WARN_MULTIPLE,
  GAP_RECOVERY_EVENT_LIMIT,
} from "./lib/constants.mjs";
import { assertWebSocketUrl, ensureStateDir, loadConfig, statePath } from "./lib/config.mjs";
import { inspectReady } from "./lib/ready.mjs";
import { inspect as inspectLock, tryAcquire } from "./lib/lock.mjs";
import { deriveWsUrl, loadContract, recoveryAvailable, validateContract } from "./lib/contract.mjs";
import { projectRun } from "./lib/costs.mjs";
import { reapStaleReservations, summary as ledgerSummary } from "./lib/ledger.mjs";
import { SkillError } from "./lib/cdp.mjs";
import { buySocketSession, fetchEvents, renewWatch } from "./lib/watch-ops.mjs";
import { get as getWatch, list as listWatches, msUntilExpiry } from "./lib/watches.mjs";
import { Notifier } from "./lib/notify.mjs";
import { amendNotified, appendSignal, deriveEventId } from "./lib/spool.mjs";
import { formatDollars, mask, scrub } from "./lib/output.mjs";

const LOCK_STALE_MS = 90_000;
const HEARTBEAT_MS = 15_000;

/* ----------------------------------------------------------------- output */

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify(scrub({ event, ts: new Date().toISOString(), ...fields }))}\n`);
}

/* -------------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const tickers = [];
  let hours = 24;
  let statusInterval = 300;
  let acceptSessionLoss = false;
  let recoverGaps = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ticker") tickers.push(String(argv[++i] || "").toUpperCase());
    else if (arg.startsWith("--ticker=")) tickers.push(arg.split("=")[1].toUpperCase());
    else if (arg === "--hours") hours = Number(argv[++i]);
    else if (arg.startsWith("--hours=")) hours = Number(arg.split("=")[1]);
    else if (arg === "--status-interval") statusInterval = Number(argv[++i]);
    else if (arg === "--accept-session-loss") acceptSessionLoss = true;
    else if (arg === "--no-recover-gaps") recoverGaps = false;
    else if (arg === "--recover-gaps") recoverGaps = true;
  }
  return {
    tickers: tickers.filter(Boolean),
    hours: Number.isFinite(hours) && hours > 0 ? hours : 24,
    statusInterval: Number.isFinite(statusInterval) && statusInterval > 0 ? statusInterval : 300,
    acceptSessionLoss,
    recoverGaps,
  };
}

/* -------------------------------------------------- session metadata file */

function sessionMetaPath() {
  return statePath("session.json");
}

/**
 * Record the non-secret facts about a paid session BEFORE connecting.
 *
 * The token itself is deliberately never written. That means a crash loses
 * access to a session the user already paid for — which is exactly why this
 * record exists: so the loss is reported honestly instead of vanishing.
 */
function writeSessionMeta(meta) {
  ensureStateDir();
  const tmp = `${sessionMetaPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, sessionMetaPath());
}

function readSessionMeta() {
  try {
    return JSON.parse(fs.readFileSync(sessionMetaPath(), "utf8"));
  } catch {
    return null;
  }
}

function clearSessionMeta() {
  try {
    fs.unlinkSync(sessionMetaPath());
  } catch {
    /* nothing to clear */
  }
}

function writeStatusFile(status) {
  ensureStateDir();
  const target = statePath("supervisor-status.json");
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/* ------------------------------------------------------------- supervisor */

class Supervisor {
  constructor(config, args) {
    this.config = config;
    this.args = args;
    this.tickers = args.tickers.length ? args.tickers : listWatches().map((w) => w.ticker);
    this.projection = projectRun(Math.max(1, this.tickers.length), args.hours);
    this.startedAt = Date.now();
    this.spentAtStart = BigInt(ledgerSummary(config.dailyLimitAtomic).spent_atomic);

    this.session = null;
    this.socket = null;
    this.stopping = false;
    this.terminal = null;
    this.reconnectAttempt = 0;
    this.lastPaidSessionAt = 0;
    this.lastFrameAt = null;
    this.disconnectedAt = null;
    this.timers = new Set();
    this.anomalyWarned = false;
    this.recoveryEnabled = config.recoverGaps;
    if (args.recoverGaps !== null) this.recoveryEnabled = args.recoverGaps;

    this.notifier = new Notifier(config, {
      onResult: ({ event_id, notified, error, code }) => {
        amendNotified(event_id, notified, error || null);
        if (!notified && code) log("notify_failed", { code, event_id, message: error });
      },
    });
  }

  track(timer) {
    this.timers.add(timer);
    return timer;
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    this.lock = tryAcquire(statePath("session.lock"), { staleMs: LOCK_STALE_MS, label: "supervisor" });
    if (!this.lock.ok) {
      log("refused", {
        code: "supervisor_already_running",
        message:
          `A signal session is already running as PID ${this.lock.holder?.pid ?? "unknown"} on ` +
          `${this.lock.holder?.host ?? "this host"}. No session was bought. Stop that process first if you want to restart.`,
        holder: this.lock.holder,
      });
      process.exit(1);
    }

    this.heartbeat = setInterval(() => this.lock.heartbeat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();

    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));

    await reapStaleReservations();

    try {
      await this.verifyContract();
      this.reportOrphanedSession();
      await this.openSession("initial");
      this.scheduleRenewals();
      this.scheduleStatus();
    } catch (err) {
      await this.fatal(err);
    }
  }

  async verifyContract() {
    const contract = await loadContract(this.config.apiBaseUrl, {
      force: true,
      servicePrefix: this.config.servicePrefix,
    });
    const mismatches = validateContract(contract.root, contract.discovery);
    if (mismatches.length) {
      throw new SkillError(
        "service_contract_mismatch",
        `The live service contract changed: ${mismatches.map((m) => `${m.field} is ${m.actual} (expected ${m.expected})`).join("; ")}. ` +
          "Refusing to spend until the operator confirms the change."
      );
    }
    this.contract = contract;
    this.wsUrl = deriveWsUrl(this.config.apiBaseUrl, contract.root.socket.path);
    if (this.recoveryEnabled && !recoveryAvailable(contract.discovery)) {
      this.recoveryEnabled = false;
      log("warning", {
        code: "recovery_unavailable",
        message:
          "This deployment does not advertise GET /watches/{ticker}/events, so signals missed during a gap cannot be recovered. " +
          "Gaps will still be reported.",
      });
    }
    log("contract_verified", {
      discovery_version: contract.discovery.version,
      session_ttl_minutes: contract.root.socket.session_ttl_minutes,
      lease_window_minutes: contract.root.lease_window_minutes,
      gap_recovery: this.recoveryEnabled,
      tickers: this.tickers,
      projected_cost_usd: formatDollars(this.projection.totalAtomic),
    });
  }

  /**
   * A session record still inside its TTL means a previous run paid for access
   * that died with the process. The money is gone either way; the point is to
   * say so rather than quietly buy another one.
   */
  reportOrphanedSession() {
    const meta = readSessionMeta();
    if (!meta?.expires_at) return;
    const remainingMs = Date.parse(meta.expires_at) - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      clearSessionMeta();
      return;
    }
    const minutes = Math.round(remainingMs / 60_000);
    if (!this.args.acceptSessionLoss) {
      log("refused", {
        code: "session_token_lost",
        message:
          `A previous run paid for a socket session that is still valid for about ${minutes} more minute(s) ` +
          `(expires ${meta.expires_at}), but its access token was lost when that process stopped. ` +
          `That ${formatDollars(PRICE_ATOMIC.session)} cannot be recovered. Re-run with --accept-session-loss to buy a new session.`,
        expires_at: meta.expires_at,
        minutes_remaining: minutes,
        wasted_usd: formatDollars(PRICE_ATOMIC.session),
      });
      this.releaseLock();
      process.exit(1);
    }
    log("warning", {
      code: "session_token_lost",
      message: `Proceeding past a lost session token with ~${minutes} minute(s) of paid time abandoned.`,
      wasted_usd: formatDollars(PRICE_ATOMIC.session),
    });
    clearSessionMeta();
  }

  /* -------------------------------------------------------------- session */

  paidSessionAllowed() {
    const since = (Date.now() - this.lastPaidSessionAt) / 1000;
    if (this.lastPaidSessionAt && since < MIN_SECONDS_BETWEEN_PAID_SESSIONS) {
      return { allowed: false, retry_in_sec: Math.ceil(MIN_SECONDS_BETWEEN_PAID_SESSIONS - since) };
    }
    return { allowed: true };
  }

  async openSession(reason) {
    if (this.stopping) return;

    const limiter = this.paidSessionAllowed();
    if (!limiter.allowed) {
      log("session_purchase_deferred", {
        code: "paid_session_rate_limited",
        reason,
        message: `Not buying another session yet; the limiter allows one every ${MIN_SECONDS_BETWEEN_PAID_SESSIONS / 60} minutes.`,
        retry_in_sec: limiter.retry_in_sec,
      });
      this.track(setTimeout(() => this.openSession(reason), limiter.retry_in_sec * 1000));
      return;
    }

    this.checkSpendAnomaly();

    let session;
    try {
      session = await buySocketSession({ config: this.config });
    } catch (err) {
      await this.fatal(err);
      return;
    }

    this.lastPaidSessionAt = Date.now();
    const expiresAt =
      session.expiresAt ||
      new Date(Date.now() + (session.ttlMinutes || CONTRACT.sessionTtlMinutes) * 60_000).toISOString();

    // Written before connecting so a crash between paying and connecting is
    // still visible to the next run.
    writeSessionMeta({
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      ws_host: new URL(session.wsUrl || this.wsUrl).host,
      payer_prefix: mask(session.payer, 10),
      tx_prefix: session.txPrefix,
      amount_atomic: session.amountAtomic,
    });

    this.wsUrl = session.wsUrl || this.wsUrl;
    const wsCheck = assertWebSocketUrl(this.wsUrl, this.config, this.contract.root.socket.path);
    if (!wsCheck.ok) {
      clearSessionMeta();
      throw new SkillError(wsCheck.code, wsCheck.message);
    }
    this.session = { token: session.token, expiresAt, payer: session.payer };
    log("session_purchased", {
      reason,
      expires_at: expiresAt,
      payer_prefix: mask(session.payer, 10),
      tx_prefix: session.txPrefix,
      cost_usd: formatDollars(BigInt(session.amountAtomic)),
      token_prefix: mask(session.token),
    });

    this.scheduleRebuy();
    this.connect();
  }

  scheduleRebuy() {
    if (!this.session?.expiresAt) return;
    const leadMs = SESSION_REBUY_LEAD_SEC * 1000;
    const delay = Math.max(5_000, Date.parse(this.session.expiresAt) - Date.now() - leadMs);
    this.track(
      setTimeout(() => {
        if (this.stopping || this.terminal) return;
        log("session_rebuy_due", { expires_at: this.session?.expiresAt });
        this.swapSession();
      }, delay)
    );
  }

  /**
   * Replace the session before it expires.
   *
   * The service allows one connection per payer, so buying a new session very
   * likely evicts this socket. The old socket is closed first and the gap is
   * recorded, which is the safe assumption whichever way the service behaves.
   */
  async swapSession() {
    const old = this.socket;
    this.socket = null;
    if (old) {
      old.removeAllListeners();
      try {
        old.close(1000, "session rotation");
      } catch {
        /* already closing */
      }
    }
    this.markDisconnected("session_rotation");
    await this.openSession("pre_expiry_rotation");
  }

  /* --------------------------------------------------------------- socket */

  connect() {
    if (this.stopping || !this.session) return;

    const separator = this.wsUrl.includes("?") ? "&" : "?";
    const url = `${this.wsUrl}${separator}${CONTRACT.socketTokenQueryParam}=${encodeURIComponent(this.session.token)}`;
    const socket = new WebSocket(url, { handshakeTimeout: 15_000 });
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.lastFrameAt = Date.now();
      log("socket_open", { ws_host: new URL(this.wsUrl).host, token_prefix: mask(this.session.token) });
      this.resolveGap();
      this.armStaleFrameWatchdog();
    });

    socket.on("message", (data) => this.onMessage(data));

    socket.on("error", (err) => {
      log("socket_error", { code: "socket_unavailable", message: err?.message || String(err) });
    });

    socket.on("close", (code, reasonBuf) => {
      const reason = reasonBuf?.toString?.() || "";
      this.onClose(code, reason);
    });
  }

  /**
   * The server pings every 25s. Silence well past that means the connection is
   * dead in a way that produced no close event, so it is torn down explicitly.
   */
  armStaleFrameWatchdog() {
    const limitMs = (CONTRACT.pingIntervalSec * 2 + CONTRACT.pongTimeoutSec) * 1000;
    const check = () => {
      if (this.stopping || !this.socket) return;
      if (this.lastFrameAt && Date.now() - this.lastFrameAt > limitMs) {
        log("socket_stale", {
          code: "socket_unavailable",
          message: `No frame received for over ${Math.round(limitMs / 1000)}s; treating the connection as dead.`,
        });
        try {
          this.socket.terminate();
        } catch {
          /* already gone */
        }
        return;
      }
      this.track(setTimeout(check, 5_000));
    };
    this.track(setTimeout(check, 5_000));
  }

  onMessage(data) {
    this.lastFrameAt = Date.now();

    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      this.protocolViolation("The service sent a frame that is not valid JSON.");
      return;
    }

    const type = frame?.type;
    if (!type || !KNOWN_FRAME_TYPES.has(type)) {
      this.protocolViolation(`The service sent an unrecognized frame type: ${JSON.stringify(type)}.`);
      return;
    }

    if (type === "hello") return this.onHello(frame);
    if (type === "ping") return this.onPing(frame);
    if (type === "pong") return;
    if (type === "signal") return this.onSignal(frame);
  }

  onHello(frame) {
    const owner = String(frame.owner_payer || "").toLowerCase();
    const expected = String(this.session?.payer || "").toLowerCase();
    if (!owner) {
      this.protocolViolation("The hello frame carried no owner_payer, so the socket's ownership cannot be verified.");
      return;
    }
    if (expected && owner !== expected) {
      log("terminal", {
        code: "socket_hello_mismatch",
        message:
          "The connected socket is bound to a different wallet than the one that paid for it. " +
          "Closed without creating or renewing anything; do not retry payment until the operator investigates.",
        expected_prefix: mask(expected, 10),
        actual_prefix: mask(owner, 10),
      });
      this.terminate("socket_hello_mismatch");
      return;
    }
    log("socket_ready", { owner_prefix: mask(owner, 10) });
  }

  onPing(frame) {
    // The service closes the socket if the pong does not arrive within its
    // pong_timeout_sec, so this replies immediately rather than on a timer.
    try {
      this.socket?.send(JSON.stringify({ type: "pong", t: frame.t }));
    } catch (err) {
      log("socket_error", { code: "socket_unavailable", message: `Could not send pong: ${err.message}` });
    }
  }

  onSignal(frame) {
    const payload = frame.payload ?? frame.data ?? frame.signal ?? null;
    if (!payload || typeof payload !== "object") {
      this.protocolViolation("A signal frame arrived without a payload object.");
      return;
    }
    const disclosure = payload.disclosure ?? frame.disclosure ?? null;
    if (!disclosure) {
      this.protocolViolation("A signal frame arrived without the required disclosure.");
      return;
    }

    const ticker = frame.ticker || payload.ticker || null;
    const eventId = frame.event_id || payload.event_id || payload.id || deriveEventId(payload, ticker);
    this.ingestSignal({ eventId, ticker, payload, disclosure, source: "socket" });
  }

  /** Returns true when the signal was new, false when it was a known duplicate. */
  ingestSignal({ eventId, ticker, payload, disclosure, source }) {
    const { appended, event_id } = appendSignal({ eventId, ticker, payload, disclosure, source });
    if (!appended) {
      log("signal_duplicate", { event_id, source });
      return false;
    }
    log("signal", { event_id, ticker, source, notified: this.notifier.configured });
    this.notifier.enqueue({
      eventId: event_id,
      ticker,
      payload,
      disclosure,
      receivedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Anything outside the approved protocol closes the socket and stops. The
   * service may be fine and this client may simply be out of date, but
   * guessing at an unknown protocol with a paying wallet attached is worse
   * than stopping.
   */
  protocolViolation(message) {
    log("terminal", {
      code: "socket_protocol_unrecognized",
      message: `${message} Closed safely without spending again; the operator needs to confirm the socket protocol.`,
    });
    this.terminate("socket_protocol_unrecognized");
  }

  onClose(code, reason) {
    if (this.stopping) return;
    this.markDisconnected(`close_${code}`);

    const mapped = CLOSE_CODE_ACTIONS[code];
    if (!mapped) {
      log("terminal", {
        code: "socket_closed",
        close_code: code,
        close_reason: reason,
        message:
          `The service closed the connection with code ${code}, which this skill does not recognize. ` +
          "Stopped without spending again; the operator needs to confirm the close-code meaning.",
      });
      this.terminate("socket_closed");
      return;
    }

    if (mapped.action === "terminal") {
      const terminalMessage = mapped.code === "socket_unauthorized"
        ? "The service rejected the socket token. Stopping without buying again; inspect the paid session state before recovering."
        : "Another client connected with this wallet and took over the single allowed connection. Stopping instead of buying another session, which would have billed you twice and started a tug of war.";
      log("terminal", {
        code: mapped.code,
        close_code: code,
        close_reason: reason,
        message: terminalMessage,
      });
      this.terminate(mapped.code);
      return;
    }

    if (mapped.action === "rebuy") {
      log("session_expired", { close_code: code, code: mapped.code, message: "Session no longer valid; buying one replacement." });
      clearSessionMeta();
      this.session = null;
      this.openSession("session_expired");
      return;
    }

    const backoff = this.nextBackoff(mapped.action === "backoff");
    log("socket_reconnecting", {
      code: mapped.code,
      close_code: code,
      close_reason: reason,
      in_ms: backoff,
      message: "Retrying the existing paid session. No new session will be bought for a transport problem.",
    });
    this.track(setTimeout(() => this.reconnectOrRebuy(), backoff));
  }

  nextBackoff(aggressive) {
    this.reconnectAttempt += 1;
    const base = Math.min(
      RECONNECT_BACKOFF_MAX_MS,
      RECONNECT_BACKOFF_MIN_MS * 2 ** Math.min(this.reconnectAttempt, 6) * (aggressive ? 4 : 1)
    );
    return Math.round(base / 2 + Math.random() * (base / 2));
  }

  reconnectOrRebuy() {
    if (this.stopping || this.terminal) return;
    const expiresMs = this.session ? Date.parse(this.session.expiresAt) - Date.now() : -1;
    if (this.session && expiresMs > 30_000) {
      this.connect();
      return;
    }
    clearSessionMeta();
    this.session = null;
    this.openSession("token_expired_during_reconnect");
  }

  /* ------------------------------------------------------------- gap track */

  markDisconnected(reason) {
    if (this.disconnectedAt) return;
    this.disconnectedAt = { at: Date.now(), reason, last_frame_at: this.lastFrameAt };
  }

  /**
   * Report the gap first, then try to recover it. The report happens
   * unconditionally, because a user who missed signals deserves to know even
   * when recovery is off, unaffordable, or unavailable.
   */
  resolveGap() {
    if (!this.disconnectedAt) return;
    const from = new Date(this.disconnectedAt.last_frame_at || this.disconnectedAt.at).toISOString();
    const to = new Date().toISOString();
    const seconds = Math.round((Date.now() - (this.disconnectedAt.last_frame_at || this.disconnectedAt.at)) / 1000);
    const reason = this.disconnectedAt.reason;
    this.disconnectedAt = null;

    if (seconds < this.config.gapMinSeconds) {
      log("gap_ignored", { from, to, seconds, reason, message: "Gap shorter than the configured minimum." });
      return;
    }

    log("gap_detected", {
      from,
      to,
      seconds,
      reason,
      message: `You were disconnected from ${from} to ${to}; signals in that window were not delivered over the socket.`,
    });

    if (!this.recoveryEnabled) {
      log("gap_recovery_skipped", {
        code: "recovery_unavailable",
        message: "Paid catch-up is disabled or unavailable on this deployment, so the gap was reported but not recovered.",
      });
      return;
    }

    const remaining = BigInt(ledgerSummary(this.config.dailyLimitAtomic).remaining_atomic);
    if (remaining < PRICE_ATOMIC.renew * 2n) {
      log("gap_recovery_skipped", {
        code: "daily_spend_cap_reached",
        message:
          `Skipping paid catch-up: only ${formatDollars(remaining)} of today's budget is left, which is reserved for keeping ` +
          "the watch alive rather than backfilling.",
      });
      return;
    }

    this.recoverGap(from).catch((err) => {
      log("gap_recovery_failed", { code: err.code || "recovery_failed", message: err.message });
    });
  }

  async recoverGap(from) {
    for (const ticker of this.tickers) {
      const result = await fetchEvents({ config: this.config, ticker, limit: GAP_RECOVERY_EVENT_LIMIT });
      if (!result.ok) {
        log("gap_recovery_failed", {
          ticker,
          code: result.code || "recovery_failed",
          message: result.message || `The catch-up poll returned ${result.status}.`,
        });
        continue;
      }
      const events = Array.isArray(result.body) ? result.body : result.body?.events || [];
      let recovered = 0;
      for (const event of events) {
        const payload = event.payload ?? event;
        const disclosure = payload?.disclosure ?? event?.disclosure ?? null;
        if (!disclosure) continue;
        const eventId = event.event_id || event.id || deriveEventId(payload, ticker);
        if (this.ingestSignal({ eventId, ticker, payload, disclosure, source: "gap_recovery" })) recovered += 1;
      }
      log("gap_recovery_complete", {
        ticker,
        from,
        examined: events.length,
        recovered,
        cost_usd: formatDollars(PRICE_ATOMIC.events),
        message: `Paid catch-up polled ${events.length} stored event(s) for ${ticker} and recovered ${recovered} that the socket missed.`,
      });
    }
  }

  /* ------------------------------------------------------------- renewals */

  scheduleRenewals() {
    for (const ticker of this.tickers) this.scheduleRenewal(ticker);
  }

  /**
   * Renew at expiry minus 15 minutes rather than at expiry.
   *
   * Renewals extend the lease from its current expiry, so renewing early costs
   * nothing extra and leaves a full retry window if one attempt fails.
   */
  scheduleRenewal(ticker) {
    const untilExpiry = msUntilExpiry(ticker);
    let delay;
    if (untilExpiry === null) {
      // No local record of this lease, so its expiry is unknown. Renewing now
      // costs one call and replaces a guess with a known expiry.
      log("renew_expiry_unknown", {
        ticker,
        message: "No local lease record for this ticker, so renewing once now to establish a known expiry.",
      });
      delay = 0;
    } else {
      delay = Math.max(0, untilExpiry - RENEW_LEAD_SEC * 1000);
    }

    this.track(
      setTimeout(async () => {
        if (this.stopping || this.terminal) return;
        this.checkSpendAnomaly();
        try {
          const result = await renewWatch({ config: this.config, ticker });
          if (result.ok) {
            log("renewed", {
              ticker,
              expires_at: result.watch?.expires_at,
              cost_usd: formatDollars(PRICE_ATOMIC.renew),
              tx_prefix: result.tx_prefix,
            });
            this.scheduleRenewal(ticker);
          } else {
            log("renew_failed", {
              ticker,
              code: result.code || "request_rejected",
              message: result.message || `Renew returned ${result.status}.`,
            });
            this.retryRenewal(ticker);
          }
        } catch (err) {
          if (err.code === "daily_spend_cap_reached") {
            await this.cleanStop("daily_spend_cap_reached", err.message, err.extra);
            return;
          }
          log("renew_failed", { ticker, code: err.code || "renew_error", message: err.message });
          this.retryRenewal(ticker);
        }
      }, delay)
    );
  }

  /** One failed renew still leaves the lead time, so retry inside it. */
  retryRenewal(ticker) {
    const untilExpiry = msUntilExpiry(ticker);
    if (untilExpiry !== null && untilExpiry <= 0) {
      log("lease_expired", {
        ticker,
        message: `The lease for ${ticker} expired and could not be renewed. Signals for it have stopped; restart it with start-watch.`,
      });
      return;
    }
    const delay = Math.min(5 * 60_000, Math.max(30_000, (untilExpiry ?? 60_000) / 3));
    this.track(setTimeout(() => this.scheduleRenewal(ticker), delay));
  }

  /* ---------------------------------------------------------------- spend */

  spentThisRun() {
    const now = BigInt(ledgerSummary(this.config.dailyLimitAtomic).spent_atomic);
    return now > this.spentAtStart ? now - this.spentAtStart : 0n;
  }

  /**
   * A $200/day ceiling is far too distant to be an early warning, so the real
   * guard compares actual spend against the projection for this specific run.
   */
  checkSpendAnomaly() {
    const elapsedHours = (Date.now() - this.startedAt) / 3_600_000;
    const expected = projectRun(Math.max(1, this.tickers.length), Math.max(0.1, elapsedHours)).totalAtomic;
    const actual = this.spentThisRun();
    if (expected <= 0n) return;

    if (actual > expected * BigInt(SPEND_ANOMALY_STOP_MULTIPLE)) {
      this.cleanStop(
        "spend_anomaly_detected",
        `Spend for this run is ${formatDollars(actual)} against a projection of ${formatDollars(expected)} — more than ` +
          `${SPEND_ANOMALY_STOP_MULTIPLE}x. Stopping rather than continuing to burn the wallet.`,
        { projected_usd: formatDollars(expected), actual_usd: formatDollars(actual) }
      );
      return;
    }
    if (!this.anomalyWarned && actual > expected * BigInt(SPEND_ANOMALY_WARN_MULTIPLE)) {
      this.anomalyWarned = true;
      log("warning", {
        code: "spend_anomaly_detected",
        message:
          `You planned about ${formatDollars(expected)} by now but have spent ${formatDollars(actual)}. ` +
          `Flagging this well before the ${formatDollars(this.config.dailyLimitAtomic)} ceiling, which is too far away to be a useful signal.`,
        projected_usd: formatDollars(expected),
        actual_usd: formatDollars(actual),
      });
    }
  }

  scheduleStatus() {
    const tick = () => {
      if (this.stopping) return;
      const ledger = ledgerSummary(this.config.dailyLimitAtomic);
      const status = {
        event: "status",
        ts: new Date().toISOString(),
        pid: process.pid,
        connected: this.socket?.readyState === WebSocket.OPEN,
        tickers: this.tickers.map((t) => ({ ticker: t, expires_at: getWatch(t)?.expires_at ?? null })),
        session_expires_at: this.session?.expiresAt ?? null,
        spent_today_usd: formatDollars(BigInt(ledger.spent_atomic)),
        spent_this_run_usd: formatDollars(this.spentThisRun()),
        cap_usd: formatDollars(BigInt(ledger.cap_atomic)),
        remaining_usd: formatDollars(BigInt(ledger.remaining_atomic)),
        cap_resets_at: ledger.resets_at,
        gap_recovery: this.recoveryEnabled,
        notify_configured: this.notifier.configured,
      };
      writeStatusFile(status);
      log("status", status);
      this.track(setTimeout(tick, this.args.statusInterval * 1000));
    };
    tick();
  }

  /* ------------------------------------------------------------- shutdown */

  releaseLock() {
    clearInterval(this.heartbeat);
    this.lock?.release?.();
  }

  terminate(code) {
    this.terminal = code;
    this.shutdown(code, 1);
  }

  async fatal(err) {
    const code = err?.code || "unexpected_error";
    log("fatal", {
      code,
      message: err?.message || String(err),
      ...(err?.extra || {}),
    });
    await this.shutdown(code, 1);
  }

  /**
   * Reaching the cap is a clean stop, not a crash: stop renewing, close the
   * socket, and say when the budget window resets.
   */
  async cleanStop(code, message, extra = {}) {
    log("stopped", {
      code,
      message,
      ...extra,
      resets_at: ledgerSummary(this.config.dailyLimitAtomic).resets_at,
    });
    await this.shutdown(code, 1);
  }

  async shutdown(reason, exitCode = 0) {
    if (this.stopping) return;
    this.stopping = true;
    this.clearTimers();

    if (this.socket) {
      this.socket.removeAllListeners();
      try {
        this.socket.close(1000, "supervisor shutting down");
      } catch {
        /* already closed */
      }
    }

    await this.notifier.drain().catch(() => {});

    const ledger = ledgerSummary(this.config.dailyLimitAtomic);
    log("shutdown", {
      reason,
      spent_this_run_usd: formatDollars(this.spentThisRun()),
      spent_today_usd: formatDollars(BigInt(ledger.spent_atomic)),
      message:
        "The stream has stopped and no further charges will be made by this process. " +
        "Watch leases keep running until they expire; use stop-watch.sh to tear one down.",
    });

    clearSessionMeta();
    this.releaseLock();
    process.exit(exitCode);
  }
}

/* -------------------------------------------------------------------- main */

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();

const ready = inspectReady();
if (!ready.ok) {
  log("refused", {
    code: ready.code,
    setup_needed: true,
    setup_doc: ready.setup_doc,
    setup_step: ready.setup_step,
    message: ready.next_action,
    problems: ready.problems,
  });
  process.exit(1);
}

if (!args.tickers.length && !listWatches().length) {
  log("refused", {
    code: "no_watches",
    message:
      "No tickers were given and no local watch records exist. Start a watch first with start-watch.sh, " +
      "or pass --ticker SYMBOL. No session was bought.",
  });
  process.exit(2);
}

const existing = inspectLock(statePath("session.lock"), { staleMs: LOCK_STALE_MS });
if (existing.held) {
  log("refused", {
    code: "supervisor_already_running",
    message: `A signal session is already running as PID ${existing.pid}. No session was bought.`,
    holder: existing,
  });
  process.exit(1);
}

const supervisor = new Supervisor(config, args);
supervisor.start().catch((err) => supervisor.fatal(err));
