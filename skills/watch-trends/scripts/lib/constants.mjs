/**
 * Verified public constants for the watch-trends x402 service.
 *
 * Everything here is a seller/protocol value or a local safety default. Nothing
 * in this file is a user secret. The values under CONTRACT are safety pins:
 * doctor re-reads them from live discovery and fails closed on a mismatch
 * rather than trusting these copies.
 */

export const USDC_DECIMALS = 6;
export const USDC_BASE_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = 8453;

export const DEFAULT_API_BASE_URL = "https://agents.smarterway.tech";
export const DEFAULT_SERVICE_PREFIX = "/services/watch-trends/v1";
export const DEFAULT_PAY_TO = "0x7f985b1764f79faa42a4622bb605b23c8eb5abea";
export const DEFAULT_NETWORK = "eip155:8453";

/** Dedicated buyer account. Never the user's general trading wallet. */
export const DEFAULT_CDP_ACCOUNT_NAME = "WatchTrendsBuyer";

/**
 * Account names known to hold general trading balances. Resolving to one of
 * these is refused unless WATCHTRENDS_ALLOW_SHARED_WALLET=1.
 */
export const KNOWN_TRADING_ACCOUNTS = [
  "coinbasetraderagent",
  "coinbase-trader",
  "coinbasetrader",
  "tradingagent",
  "trading-agent",
  "default",
];

/** Price per paid call, in atomic Base USDC. $0.01 each. */
export const PRICE_ATOMIC = {
  start: 10_000n,
  renew: 10_000n,
  session: 10_000n,
  events: 10_000n,
  list: 10_000n,
};

/** Local guardrails. Users may lower these; the agent never raises them. */
export const DEFAULT_MAX_AMOUNT_ATOMIC = 10_000n; // $0.01, one call
export const DEFAULT_DAILY_LIMIT_ATOMIC = 200_000_000n; // $200.00/day runaway ceiling

/** Service contract, mirrored from GET / on the deployed service. */
export const CONTRACT = {
  discoveryVersion: "2",
  x402Version: 2,
  servicePrefix: DEFAULT_SERVICE_PREFIX,
  socketPath: `${DEFAULT_SERVICE_PREFIX}/ws/signals`,
  socketTokenQueryParam: "token",
  sessionTtlMinutes: 30,
  pingIntervalSec: 25,
  pongTimeoutSec: 10,
  oneConnectionPerPayer: true,
  clientMustPong: true,
  leaseWindowMinutes: 30,
  maxTimeoutSeconds: 60,
  eip712DomainName: "USD Coin",
  eip712DomainVersion: "2",
};

/** Paid routes the skill is allowed to call, from discovery `paid_routes`. */
export const PAID_ROUTES = {
  start: { method: "POST", path: "/watches" },
  renew: { method: "POST", path: "/watches/{ticker}/renew" },
  stop: { method: "DELETE", path: "/watches/{ticker}" },
  session: { method: "POST", path: "/socket/session" },
  list: { method: "GET", path: "/watches" },
  events: { method: "GET", path: "/watches/{ticker}/events" },
};

/**
 * Supervisor timing.
 *
 * Renewals extend the existing lease by WINDOW minutes from its current expiry,
 * so renewing early costs nothing extra and buys a safety margin. Sessions are
 * replaced rather than extended, so a pre-expiry re-buy genuinely raises the
 * purchase cadence from 30 to 25 minutes. That is priced honestly in costs.mjs.
 */
export const RENEW_LEAD_SEC = 15 * 60;
export const SESSION_REBUY_LEAD_SEC = 5 * 60;

/** Transport reconnect backoff. Never triggers a purchase on its own. */
export const RECONNECT_BACKOFF_MIN_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 60_000;

/** Paid-session limiter, deliberately far stricter than transport backoff. */
export const MIN_SECONDS_BETWEEN_PAID_SESSIONS = 5 * 60;

/** Spend anomaly guard, relative to the budget-plan projection for the run. */
export const SPEND_ANOMALY_WARN_MULTIPLE = 3;
export const SPEND_ANOMALY_STOP_MULTIPLE = 10;

/** Cost projection safety margin applied to the recommended daily cap. */
export const BUDGET_SAFETY_MARGIN = 1.25;

/** Clock skew tolerance. x402 authorizations carry a 60-second validBefore. */
export const MAX_CLOCK_SKEW_SEC = 10;

/** Doctor probe caching, so repeated agent runs do not trip service limits. */
export const CONTRACT_CACHE_TTL_SEC = 10 * 60;
export const MAX_UNPAID_PROBES_PER_HOUR = 6;

/** Signal spool rotation. */
export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;
export const SPOOL_MAX_ENTRIES = 10_000;

/** Notify hook execution limits. */
export const NOTIFY_TIMEOUT_MS = 10_000;
export const NOTIFY_MAX_ATTEMPTS = 3;

/** Gap recovery. */
export const DEFAULT_GAP_MIN_SECONDS = 5;
export const GAP_RECOVERY_EVENT_LIMIT = 50;

/**
 * WebSocket close-code handling.
 *
 * `rebuy` is the only action permitted to spend money, and it is additionally
 * rate limited. The 4001/4003/4401 meanings are assumed from the service
 * blueprint and are still pending authoritative confirmation; anything not
 * listed here is treated as unknown and never spends.
 */
export const CLOSE_CODE_ACTIONS = {
  1000: { action: "reconnect", code: "socket_unavailable" },
  1001: { action: "reconnect", code: "socket_unavailable" },
  1006: { action: "reconnect", code: "socket_unavailable" },
  1011: { action: "reconnect", code: "socket_unavailable" },
  1012: { action: "reconnect", code: "socket_unavailable" },
  1013: { action: "backoff", code: "too_many_connections" },
  4001: { action: "terminal", code: "socket_replaced_elsewhere" },
  4002: { action: "rebuy", code: "socket_session_expired" },
  4003: { action: "reconnect", code: "socket_zombie" },
  4401: { action: "terminal", code: "socket_unauthorized" },
};

/** Frame types the client is willing to act on. Anything else fails closed. */
export const KNOWN_FRAME_TYPES = new Set(["hello", "ping", "pong", "signal"]);
