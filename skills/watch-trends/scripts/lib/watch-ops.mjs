/**
 * Paid watch lifecycle operations shared by the CLI scripts and the supervisor.
 */

import { PRICE_ATOMIC } from "./constants.mjs";
import { payRequest } from "./x402.mjs";
import { expiryFromResponse, recordRenew, recordStart, recordStop } from "./watches.mjs";
import { SkillError } from "./cdp.mjs";
import { apiUrl } from "./config.mjs";

/**
 * Reject a start price that cannot be right.
 *
 * A mistyped price silently produces a threshold band around the wrong number,
 * so the watch either never fires or fires constantly — and the user pays
 * either way. `reference` is optional; when the agent has a live quote it is
 * compared, otherwise only the obvious impossibilities are caught.
 */
export function validateStartPrice(startPrice, reference = null) {
  const price = Number(startPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      ok: false,
      code: "start_price_implausible",
      message: `The start price "${startPrice}" is not a positive number, so the threshold band would be meaningless.`,
    };
  }
  if (reference !== null && reference !== undefined) {
    const ref = Number(reference);
    if (Number.isFinite(ref) && ref > 0) {
      const drift = Math.abs(price - ref) / ref;
      if (drift > 0.2) {
        return {
          ok: false,
          code: "start_price_implausible",
          message:
            `The start price ${price} is ${(drift * 100).toFixed(1)}% away from the reference price ${ref}. ` +
            "Refusing to pay for a watch built on a price that far off; re-confirm the current price with the user.",
        };
      }
    }
  }
  return { ok: true, price };
}

export async function startWatch({ config, ticker, segment, threshold, startPrice, assetType, confidence, dryRun }) {
  const symbol = String(ticker).toUpperCase();
  const body = {
    ticker: symbol,
    segment: String(segment),
    threshold: Number(threshold),
    start_price: Number(startPrice),
  };
  if (assetType) body.asset_type = assetType;
  if (confidence !== undefined && confidence !== null) body.confidence = Number(confidence);

  const result = await payRequest({
    method: "POST",
    url: apiUrl(config, "/watches"),
    body,
    config,
    dryRun,
    route: "POST /watches",
  });

  if (result.ok && !dryRun) {
    const expiresAt = expiryFromResponse(result.body);
    result.watch = recordStart(symbol, {
      segment: body.segment,
      threshold: body.threshold,
      startPrice: body.start_price,
      assetType: body.asset_type,
      expiresAt,
    });
  }
  result.price_atomic = PRICE_ATOMIC.start.toString();
  return result;
}

export async function renewWatch({ config, ticker, dryRun }) {
  const symbol = String(ticker).toUpperCase();
  const result = await payRequest({
    method: "POST",
    url: apiUrl(config, `/watches/${encodeURIComponent(symbol)}/renew`),
    body: {},
    config,
    dryRun,
    route: "POST /watches/{ticker}/renew",
  });

  if (result.ok && !dryRun) {
    result.watch = recordRenew(symbol, expiryFromResponse(result.body));
  }
  result.price_atomic = PRICE_ATOMIC.renew.toString();
  return result;
}

export async function stopWatch({ config, ticker, dryRun }) {
  const symbol = String(ticker).toUpperCase();
  const result = await payRequest({
    method: "DELETE",
    url: apiUrl(config, `/watches/${encodeURIComponent(symbol)}`),
    body: {},
    config,
    dryRun,
    route: "DELETE /watches/{ticker}",
  });
  if (result.ok && !dryRun) recordStop(symbol);
  return result;
}

/** Buy a socket session. The token is returned in memory and never persisted. */
export async function buySocketSession({ config, ttlMinutes }) {
  const body = {};
  if (ttlMinutes) body.ttl_minutes = Number(ttlMinutes);

  const result = await payRequest({
    method: "POST",
    url: apiUrl(config, "/socket/session"),
    body,
    config,
    route: "POST /socket/session",
  });

  if (!result.ok) {
    throw new SkillError(result.code || "socket_session_failed", result.message || "The paid socket session could not be created.", {
      status: result.status,
    });
  }

  const token = result.body?.token || result.body?.session_token || result.body?.session?.token;
  if (result.body?.replay) {
    throw new SkillError(
      "socket_session_replay_unrecoverable",
      "The payment was already used for a socket session, but the service did not return its token. Refusing to buy again automatically."
    );
  }
  if (!token) {
    throw new SkillError(
      "socket_protocol_unrecognized",
      "The session response did not contain a token in any documented field. Not retrying, so no further money is spent."
    );
  }

  return {
    token,
    wsUrl: result.body?.ws_url || null,
    expiresAt: result.body?.expires_at || null,
    ttlMinutes: result.body?.ttl_minutes ?? null,
    payer: result.payer,
    txPrefix: result.tx_prefix,
    amountAtomic: result.amount_atomic,
  };
}

/** Paid debug poll used only to recover signals missed during a socket gap. */
export async function fetchEvents({ config, ticker, limit }) {
  const symbol = String(ticker).toUpperCase();
  const url = new URL(apiUrl(config, `/watches/${encodeURIComponent(symbol)}/events`));
  if (limit) url.searchParams.set("limit", String(limit));

  return payRequest({
    method: "GET",
    url: url.toString(),
    config,
    route: "GET /watches/{ticker}/events",
  });
}
