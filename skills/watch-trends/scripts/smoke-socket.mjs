#!/usr/bin/env node
/**
 * Paid smoke tests. THESE SPEND REAL MONEY and require --spend explicitly.
 *
 * Every stage is opt-in because a socket session costs $0.01 and is not
 * idempotent: running these casually both charges the user and evicts whatever
 * connection they already had.
 *
 * Usage:
 *   node scripts/smoke-socket.mjs --spend --session
 *   node scripts/smoke-socket.mjs --spend --listen --duration 35
 *   node scripts/smoke-socket.mjs --spend --watch-smoke --ticker BTC   # operator only
 */

import WebSocket from "ws";

import { CONTRACT, KNOWN_FRAME_TYPES, PRICE_ATOMIC } from "./lib/constants.mjs";
import { assertWebSocketUrl, loadConfig, statePath } from "./lib/config.mjs";
import { inspect as inspectLock } from "./lib/lock.mjs";
import { deriveWsUrl, loadContract, validateContract } from "./lib/contract.mjs";
import { SkillError } from "./lib/cdp.mjs";
import { buySocketSession } from "./lib/watch-ops.mjs";
import { emit, formatDollars, mask, run } from "./lib/output.mjs";
import { failIfNotReady } from "./lib/ready.mjs";

const STAGE = "smoke-socket";

run(STAGE, async () => {
  const argv = process.argv.slice(2);
  const spend = argv.includes("--spend");
  const wantSession = argv.includes("--session");
  const wantListen = argv.includes("--listen");
  const wantWatchSmoke = argv.includes("--watch-smoke");
  const durationIndex = argv.indexOf("--duration");
  const duration = durationIndex >= 0 ? Number(argv[durationIndex + 1]) || 35 : 35;

  if (!spend) {
    emit({
      ok: false,
      stage: STAGE,
      code: "spend_confirmation_required",
      message:
        `These tests buy a real socket session for ${formatDollars(PRICE_ATOMIC.session)} and replace any session you ` +
        "already have. Re-run with --spend once the user has explicitly agreed.",
      next_action: "Ask the user for explicit consent to spend, then re-run with --spend.",
    });
    process.exit(2);
  }

  if (wantWatchSmoke) {
    emit({
      ok: false,
      stage: STAGE,
      code: "operator_only",
      message:
        "The forced-signal test requires service-side E2E controls that ordinary users do not have. " +
        "It is not offered through this skill.",
      next_action: "Do not offer this test to the user. Operators run it against a service test harness.",
    });
    process.exit(2);
  }

  failIfNotReady(STAGE);

  const config = loadConfig();

  // A running supervisor owns the payer's single connection slot. Buying here
  // would evict it and start a paid tug of war.
  const lock = inspectLock(statePath("session.lock"), { staleMs: 90_000 });
  if (lock.held) {
    emit({
      ok: false,
      stage: STAGE,
      code: "supervisor_already_running",
      message:
        `The supervisor is running as PID ${lock.pid} and owns this wallet's single allowed connection. ` +
        "Buying a session now would disconnect it. Stop the supervisor first.",
      next_action: "Stop the supervisor, then re-run the smoke test.",
    });
    process.exit(1);
  }

  const contract = await loadContract(config.apiBaseUrl, {
    force: true,
    servicePrefix: config.servicePrefix,
  });
  const mismatches = validateContract(contract.root, contract.discovery);
  if (mismatches.length) {
    emit({
      ok: false,
      stage: STAGE,
      code: "service_contract_mismatch",
      message: `Refusing to spend: ${mismatches.map((m) => `${m.field} is ${m.actual}`).join("; ")}.`,
      mismatches,
    });
    process.exit(1);
  }

  const wsUrl = deriveWsUrl(config.apiBaseUrl, contract.root.socket.path);
  const canonicalCheck = assertWebSocketUrl(wsUrl, config, contract.root.socket.path);
  if (!canonicalCheck.ok) {
    emit({ ok: false, stage: STAGE, code: canonicalCheck.code, message: canonicalCheck.message });
    process.exit(1);
  }
  const results = [];

  let session;
  try {
    session = await buySocketSession({ config });
  } catch (err) {
    emit({
      ok: false,
      stage: STAGE,
      code: err instanceof SkillError ? err.code : "socket_session_failed",
      message: err.message,
      ...(err.extra || {}),
    });
    process.exit(1);
  }

  results.push({
    test: "S1_paid_session",
    ok: true,
    token_prefix: mask(session.token),
    ws_url: session.wsUrl || wsUrl,
    expires_at: session.expiresAt,
    payer_prefix: mask(session.payer, 10),
    tx_prefix: session.txPrefix,
    cost_usd: formatDollars(BigInt(session.amountAtomic)),
    canonical_host: new URL(wsUrl).host,
    host_matches: !session.wsUrl || new URL(session.wsUrl).host === new URL(wsUrl).host,
  });
  const sessionWsCheck = assertWebSocketUrl(session.wsUrl || wsUrl, config, contract.root.socket.path);
  if (!sessionWsCheck.ok) {
    emit({
      ok: false,
      stage: STAGE,
      code: sessionWsCheck.code,
      message: sessionWsCheck.message,
      results,
    });
    process.exit(1);
  }

  if (wantSession && !wantListen) {
    emit({ ok: true, stage: STAGE, code: "ok", spent_usd: formatDollars(BigInt(session.amountAtomic)), results });
    process.exit(0);
  }

  const listenResult = await listen(session.wsUrl || wsUrl, session, duration);
  results.push(...listenResult.results);

  emit({
    ok: listenResult.ok,
    stage: STAGE,
    code: listenResult.ok ? "ok" : listenResult.code,
    message: listenResult.message,
    spent_usd: formatDollars(BigInt(session.amountAtomic)),
    results,
    next_action: listenResult.ok
      ? "The paid socket path works end to end. Start the supervisor to run it continuously."
      : listenResult.message,
  });
  process.exit(listenResult.ok ? 0 : 1);
});

/** S2 and S3: prove the socket upgrades, binds to our payer, and stays alive. */
function listen(wsUrl, session, durationSec) {
  return new Promise((resolve) => {
    const separator = wsUrl.includes("?") ? "&" : "?";
    const url = `${wsUrl}${separator}${CONTRACT.socketTokenQueryParam}=${encodeURIComponent(session.token)}`;
    const socket = new WebSocket(url, { handshakeTimeout: 15_000 });

    let helloSeen = false;
    let helloMatched = false;
    let pings = 0;
    let pongs = 0;
    let signals = 0;
    let protocolProblem = null;
    let closed = null;

    const finish = () => {
      const stillOpen = socket.readyState === WebSocket.OPEN;
      try {
        socket.close(1000, "smoke test complete");
      } catch {
        /* already closed */
      }

      const results = [
        {
          test: "S2_authenticated_socket",
          ok: helloSeen && helloMatched,
          hello_received: helloSeen,
          owner_matches_payer: helloMatched,
        },
        {
          test: "S3_liveness",
          ok: !closed && (pings === 0 || pongs === pings),
          app_pings_received: pings,
          pongs_sent: pongs,
          still_connected_after_sec: stillOpen ? durationSec : null,
          signals_received: signals,
        },
      ];

      if (protocolProblem) {
        resolve({ ok: false, code: "socket_protocol_unrecognized", message: protocolProblem, results });
        return;
      }
      if (closed) {
        resolve({
          ok: false,
          code: "socket_closed",
          message: `The service closed the connection with code ${closed.code}${closed.reason ? ` (${closed.reason})` : ""} before the test finished.`,
          results,
        });
        return;
      }
      if (!helloSeen) {
        resolve({ ok: false, code: "socket_protocol_unrecognized", message: "No hello frame arrived.", results });
        return;
      }
      if (!helloMatched) {
        resolve({
          ok: false,
          code: "socket_hello_mismatch",
          message: "The socket was bound to a different wallet than the one that paid for it.",
          results,
        });
        return;
      }
      resolve({ ok: true, results });
    };

    const timer = setTimeout(finish, durationSec * 1000);

    socket.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        protocolProblem = "The service sent a frame that is not valid JSON.";
        clearTimeout(timer);
        finish();
        return;
      }
      if (!KNOWN_FRAME_TYPES.has(frame?.type)) {
        protocolProblem = `The service sent an unrecognized frame type: ${JSON.stringify(frame?.type)}.`;
        clearTimeout(timer);
        finish();
        return;
      }
      if (frame.type === "hello") {
        helloSeen = true;
        helloMatched =
          String(frame.owner_payer || "").toLowerCase() === String(session.payer || "").toLowerCase();
      } else if (frame.type === "ping") {
        pings += 1;
        try {
          socket.send(JSON.stringify({ type: "pong", t: frame.t }));
          pongs += 1;
        } catch {
          /* the close handler reports the failure */
        }
      } else if (frame.type === "signal") {
        signals += 1;
      }
    });

    socket.on("close", (code, reasonBuf) => {
      closed = { code, reason: reasonBuf?.toString?.() || "" };
      clearTimeout(timer);
      finish();
    });

    socket.on("error", (err) => {
      protocolProblem = protocolProblem || `Socket error: ${err.message}`;
    });
  });
}
