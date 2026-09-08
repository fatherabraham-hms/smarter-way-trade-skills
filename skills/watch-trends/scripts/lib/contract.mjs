/**
 * Service contract discovery, caching, and pinning.
 *
 * The pins in constants.mjs are safety values, not trusted defaults. Every run
 * re-reads the live contract and compares it. A change is never auto-accepted,
 * because the difference between "session TTL is 30 minutes" and "session TTL
 * is 3 minutes" is the difference between $1/day and $10/day.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import { CONTRACT, CONTRACT_CACHE_TTL_SEC, MAX_UNPAID_PROBES_PER_HOUR, MAX_CLOCK_SKEW_SEC } from "./constants.mjs";
import { ensureStateDir, statePath } from "./config.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url) {
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`refusing to follow a redirect from ${url}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
  return { status: response.status, body, dateHeader: response.headers.get("date") };
}

function cacheFile() {
  return statePath("contract-cache.json");
}

function probeFile() {
  return statePath("probe-state.json");
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeCache(data) {
  ensureStateDir();
  const tmp = `${cacheFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cacheFile());
}

/**
 * Fetch `GET /` and `GET /.well-known/x402.json`, honouring a short cache so an
 * agent looping doctor does not hammer the service.
 */
export async function loadContract(apiBaseUrl, { force = false, servicePrefix = CONTRACT.servicePrefix } = {}) {
  const cached = readCache();
  const ageSec = cached ? (Date.now() - Date.parse(cached.fetched_at)) / 1000 : Infinity;
  const normalizedPrefix = servicePrefix ? `/${servicePrefix.replace(/^\/+|\/+$/g, "")}` : "";
  if (!force && cached && cached.api_base_url === apiBaseUrl &&
      cached.service_prefix === normalizedPrefix && ageSec < CONTRACT_CACHE_TTL_SEC) {
    return { ...cached, from_cache: true, age_sec: Math.round(ageSec) };
  }

  const prefix = normalizedPrefix;
  const root = await getJson(`${apiBaseUrl}${prefix}/`);
  const discovery = await getJson(`${apiBaseUrl}${prefix}/x402.json`);

  const record = {
    api_base_url: apiBaseUrl,
    service_prefix: prefix,
    fetched_at: new Date().toISOString(),
    server_date: root.dateHeader || discovery.dateHeader || null,
    root: root.body,
    discovery: discovery.body,
  };
  writeCache(record);
  return { ...record, from_cache: false, age_sec: 0 };
}

export async function loadHealth(apiBaseUrl, servicePrefix = CONTRACT.servicePrefix) {
  const health = await getJson(`${apiBaseUrl}/health`);
  const prefix = servicePrefix ? `/${servicePrefix.replace(/^\/+|\/+$/g, "")}` : "";
  const ready = await getJson(`${apiBaseUrl}${prefix}/ready`);
  return {
    health_ok: health.status === 200 && health.body?.ok === true,
    ready_ok: ready.status === 200 && ready.body?.ok === true,
    server_date: health.dateHeader || ready.dateHeader || null,
  };
}

/**
 * Skew between the local clock and the server. x402 authorizations expire 60
 * seconds after signing, so a badly set clock produces settlement failures
 * that look like wallet problems.
 */
export function clockSkewSeconds(serverDateHeader) {
  if (!serverDateHeader) return null;
  const serverMs = Date.parse(serverDateHeader);
  if (!Number.isFinite(serverMs)) return null;
  return Math.round((Date.now() - serverMs) / 1000);
}

export function clockSkewAcceptable(skewSec) {
  return skewSec === null || Math.abs(skewSec) <= MAX_CLOCK_SKEW_SEC;
}

/**
 * Hash the fields the skill actually depends on. Cosmetic changes to the
 * description text must not trip the alarm; a price or TTL change must.
 */
export function contractHash(root, discovery) {
  const resources = (discovery?.resources || [])
    .map((r) => `${r.method} ${r.resource} ${r?.x402?.scheme ?? ""} ${r?.x402?.amount ?? r?.x402?.maxAmountRequired ?? ""}`)
    .sort();
  const normalized = {
    version: discovery?.version ?? null,
    resources,
    paid_routes: [...(root?.paid_routes || [])].sort(),
    socket: {
      path: root?.socket?.path ?? null,
      query: root?.socket?.query ?? null,
      session_ttl_minutes: root?.socket?.session_ttl_minutes ?? null,
      ping_interval_sec: root?.socket?.ping_interval_sec ?? null,
      pong_timeout_sec: root?.socket?.pong_timeout_sec ?? null,
      one_connection_per_payer: root?.socket?.one_connection_per_payer ?? null,
      client_must_pong: root?.socket?.client_must_pong ?? null,
    },
    lease_window_minutes: root?.lease_window_minutes ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function pinFile() {
  return statePath("contract-pin.json");
}

export function readPin() {
  try {
    return JSON.parse(fs.readFileSync(pinFile(), "utf8"));
  } catch {
    return null;
  }
}

export function writePin(pin) {
  ensureStateDir();
  fs.writeFileSync(pinFile(), JSON.stringify(pin, null, 2), { mode: 0o600 });
}

/**
 * Compare the live contract against the shipped expectations.
 * Returns a list of mismatches; an empty list means safe to proceed.
 */
export function validateContract(root, discovery) {
  const mismatches = [];
  const check = (field, actual, expected) => {
    if (actual !== expected) mismatches.push({ field, actual: actual ?? null, expected });
  };

  check("discovery.version", discovery?.version, CONTRACT.discoveryVersion);
  check("discovery.x402Version", discovery?.x402Version, CONTRACT.x402Version);
  check("socket.path", root?.socket?.path, CONTRACT.socketPath);
  check("socket.query", root?.socket?.query, CONTRACT.socketTokenQueryParam);
  check("socket.session_ttl_minutes", root?.socket?.session_ttl_minutes, CONTRACT.sessionTtlMinutes);
  check("socket.ping_interval_sec", root?.socket?.ping_interval_sec, CONTRACT.pingIntervalSec);
  check("socket.pong_timeout_sec", root?.socket?.pong_timeout_sec, CONTRACT.pongTimeoutSec);
  check("socket.one_connection_per_payer", root?.socket?.one_connection_per_payer, CONTRACT.oneConnectionPerPayer);
  check("socket.client_must_pong", root?.socket?.client_must_pong, CONTRACT.clientMustPong);
  check("lease_window_minutes", root?.lease_window_minutes, CONTRACT.leaseWindowMinutes);

  const session = findResource(discovery, "POST", `${CONTRACT.servicePrefix}/socket/session`);
  if (!session) {
    mismatches.push({ field: "resources[POST /socket/session]", actual: null, expected: "present" });
  } else if (String(session?.x402?.amount ?? session?.x402?.maxAmountRequired) !== "10000") {
    mismatches.push({
      field: "resources[POST /socket/session].x402.maxAmountRequired",
      actual: String(session?.x402?.maxAmountRequired),
      expected: "10000",
    });
  }

  const start = findResource(discovery, "POST", `${CONTRACT.servicePrefix}/watches`);
  if (!start) {
    mismatches.push({ field: "resources[POST /watches]", actual: null, expected: "present" });
  } else {
    const required = start?.inputSchema?.required || [];
    for (const field of ["ticker", "segment", "threshold", "start_price"]) {
      if (!required.includes(field)) {
        mismatches.push({
          field: `resources[POST /watches].inputSchema.required`,
          actual: required.join(",") || null,
          expected: `includes ${field}`,
        });
      }
    }
  }

  return mismatches;
}

export function findResource(discovery, method, resource) {
  return (discovery?.resources || []).find(
    (r) => String(r.method).toUpperCase() === method && (
      r.resource === resource || String(r.resource || "").endsWith(resource)
    )
  );
}

/** Gap recovery is only offered when discovery still advertises the route. */
export function recoveryAvailable(discovery) {
  return Boolean(findResource(discovery, "GET", `${CONTRACT.servicePrefix}/watches/{ticker}/events`));
}

export function deriveWsUrl(apiBaseUrl, socketPath) {
  const url = new URL(apiBaseUrl);
  const scheme = url.protocol === "http:" ? "ws:" : "wss:";
  return `${scheme}//${url.host}${socketPath}`;
}

/** Decode the base64-or-plain-JSON PAYMENT-REQUIRED header. */
export function parsePaymentRequired(headerValue) {
  if (!headerValue) return { ok: false, code: "missing_payment_required", message: "No PAYMENT-REQUIRED header on the 402 response." };
  let raw = headerValue;
  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf8");
    if (decoded.trim().startsWith("{")) raw = decoded;
  } catch {
    /* fall through to plain JSON */
  }
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, code: "unparseable_payment_required", message: "PAYMENT-REQUIRED header is not decodable JSON." };
  }
  const accepts = parsed.accepts || parsed.accept || [];
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return { ok: false, code: "unparseable_payment_required", message: "PAYMENT-REQUIRED carried no accepts entry." };
  }
  const resource = typeof parsed.resource === "string" ? parsed.resource : parsed.resource?.url;
  return { ok: true, requirement: accepts[0], all: accepts, resource, version: parsed.x402Version };
}

/**
 * Rate limit the unpaid 402 probe. Doctor is meant to be run repeatedly by an
 * agent, and the probe is the one no-spend check that still costs the service
 * a request against its own limiter.
 */
export function probeAllowed() {
  let state = { timestamps: [] };
  try {
    state = JSON.parse(fs.readFileSync(probeFile(), "utf8"));
  } catch {
    /* first run */
  }
  const cutoff = Date.now() - 3600_000;
  const recent = (state.timestamps || []).filter((t) => t > cutoff);
  if (recent.length >= MAX_UNPAID_PROBES_PER_HOUR) {
    return { allowed: false, recent_count: recent.length, retry_after_sec: Math.ceil((recent[0] + 3600_000 - Date.now()) / 1000) };
  }
  return { allowed: true, recent_count: recent.length };
}

export function recordProbe() {
  ensureStateDir();
  let state = { timestamps: [] };
  try {
    state = JSON.parse(fs.readFileSync(probeFile(), "utf8"));
  } catch {
    /* first run */
  }
  const cutoff = Date.now() - 3600_000;
  state.timestamps = [...(state.timestamps || []).filter((t) => t > cutoff), Date.now()];
  fs.writeFileSync(probeFile(), JSON.stringify(state), { mode: 0o600 });
}

/** Issue the unpaid request that should return 402 with a payment requirement. */
export async function probePaymentGate(url, { method = "POST", body = {} } = {}) {
  const response = await fetchWithTimeout(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  recordProbe();
  return {
    status: response.status,
    header: response.headers.get("payment-required") || response.headers.get("PAYMENT-REQUIRED"),
    dateHeader: response.headers.get("date"),
  };
}
