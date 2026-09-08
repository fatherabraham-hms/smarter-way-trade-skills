/**
 * Guarded x402 buyer.
 *
 * Order of operations matters and is not negotiable:
 *   1. validate the server's stated requirement against local allowlists
 *   2. reserve budget under lock
 *   3. only then sign
 *   4. commit or roll back the reservation based on the server's answer
 *
 * Signing before reserving would let concurrent callers both exceed the cap;
 * reserving without rolling back would leak budget on every refused call.
 */

import crypto from "node:crypto";

import { BASE_CHAIN_ID, CONTRACT, USDC_BASE_ASSET } from "./constants.mjs";
import { assertUrlAllowed } from "./config.mjs";
import { fetchWithTimeout, parsePaymentRequired } from "./contract.mjs";
import { commit, reserve, rollback } from "./ledger.mjs";
import { getBuyerAccount, SkillError } from "./cdp.mjs";
import { mask } from "./output.mjs";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

function normalizeNetwork(network) {
  const value = String(network || "").trim().toLowerCase();
  if (value === "base" || value === "base-mainnet" || value === "eip155:8453") return "eip155:8453";
  return value;
}

/**
 * Compare the server's payment requirement to the local safety pins.
 * Returns the list of mismatching fields; empty means safe to sign.
 */
export function validateRequirement(
  requirement,
  config,
  requestUrl,
  resourceUrl = null,
  challengeVersion = null,
) {
  const mismatches = [];
  const add = (field, actual, expected) => mismatches.push({ field, actual: actual ?? null, expected });

  if (String(requirement.scheme) !== "exact") add("scheme", requirement.scheme, "exact");
  if (normalizeNetwork(requirement.network) !== normalizeNetwork(config.network)) {
    add("network", requirement.network, config.network);
  }
  if (String(requirement.asset || "").toLowerCase() !== config.asset.toLowerCase()) {
    add("asset", requirement.asset, config.asset);
  }
  const payTo = String(requirement.payTo || requirement.recipient || "").toLowerCase();
  if (payTo !== config.payTo) add("payTo", payTo, config.payTo);

  let amount = 0n;
  try {
    amount = BigInt(String(requirement.maxAmountRequired ?? requirement.amount ?? "0"));
  } catch {
    add("maxAmountRequired", requirement.maxAmountRequired, "an integer");
  }
  if (amount <= 0n) add("maxAmountRequired", amount.toString(), "> 0");
  if (amount > config.maxAmountAtomic) {
    add("maxAmountRequired", amount.toString(), `<= ${config.maxAmountAtomic.toString()}`);
  }

  const timeout = Number(requirement.maxTimeoutSeconds ?? CONTRACT.maxTimeoutSeconds);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) {
    add("maxTimeoutSeconds", requirement.maxTimeoutSeconds, `<= 300`);
  }

  // The resource must be the URL we actually called, so a 402 from one route
  // cannot authorize a payment aimed at another.
  if (Number(challengeVersion) !== Number(config.expectedX402Version)) {
    add("x402Version", challengeVersion, config.expectedX402Version);
  }
  if (!resourceUrl) {
    add("resource.url", null, "the called URL");
  } else {
    const declared = String(resourceUrl).split("?")[0].replace(/\/+$/, "");
    const called = String(requestUrl).split("?")[0].replace(/\/+$/, "");
    if (declared !== called) add("resource", declared, called);
  }

  return { mismatches, amount };
}

/** Pull a short, non-reusable reference out of the settlement response. */
function settlementPrefix(headerValue) {
  if (!headerValue) return null;
  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    const tx = parsed.transaction || parsed.txHash || parsed.tx_hash || parsed.transactionHash;
    return tx ? mask(String(tx), 10) : null;
  } catch {
    return null;
  }
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Execute one paid request.
 *
 * `dryRun` stops after validation and never touches the wallet or the ledger.
 */
export async function payRequest({ method = "POST", url, body = {}, config, dryRun = false, route }) {
  const allowed = assertUrlAllowed(url);
  if (!allowed.ok) throw new SkillError(allowed.code, allowed.message);

  const hasBody = method !== "GET" && method !== "HEAD";
  const initial = await fetchWithTimeout(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: hasBody ? JSON.stringify(body) : undefined,
  });

  if (initial.status >= 300 && initial.status < 400) {
    throw new SkillError("redirect_refused", "The service tried to redirect a payment request. Refusing to follow it.");
  }

  if (initial.status !== 402) {
    const text = await initial.text();
    return {
      ok: initial.ok,
      paid: false,
      status: initial.status,
      body: tryParse(text),
      note: "The route did not ask for payment.",
    };
  }

  const parsed = parsePaymentRequired(initial.headers.get("payment-required"));
  if (!parsed.ok) throw new SkillError(parsed.code, parsed.message);

  const { mismatches, amount } = validateRequirement(
    parsed.requirement,
    config,
    url,
    parsed.resource,
    parsed.version,
  );
  if (mismatches.length) {
    throw new SkillError(
      "payment_requirements_rejected",
      "The payment the server asked for does not match this skill's safety policy, so nothing was signed.",
      { mismatches }
    );
  }

  if (dryRun) {
    return {
      ok: true,
      paid: false,
      dry_run: true,
      would_pay_atomic: amount.toString(),
      pay_to: String(parsed.requirement.payTo).toLowerCase(),
      network: parsed.requirement.network,
      asset: parsed.requirement.asset,
      resource: parsed.resource,
    };
  }

  const reservation = await reserve({
    amountAtomic: amount,
    route: route || `${method} ${new URL(url).pathname}`,
    dailyLimitAtomic: config.dailyLimitAtomic,
  });
  if (!reservation.ok) {
    throw new SkillError(reservation.code, reservation.message, {
      spent_atomic: reservation.spent_atomic,
      cap_atomic: reservation.cap_atomic,
      resets_at: reservation.resets_at,
    });
  }

  let account;
  let walletWarning = null;
  try {
    const resolved = await getBuyerAccount(config);
    account = resolved.account;
    walletWarning = resolved.warning;
  } catch (err) {
    await rollback(reservation.reservation_id, "wallet_unavailable");
    throw err;
  }

  let response;
  let text;
  try {
    const nonce = `0x${crypto.randomBytes(32).toString("hex")}`;
    const now = Math.floor(Date.now() / 1000);
    const validAfter = BigInt(now - 30);
    const validBefore = BigInt(now + Number(parsed.requirement.maxTimeoutSeconds ?? CONTRACT.maxTimeoutSeconds));

    const signature = await account.signTypedData({
      domain: {
        // Only the EIP-712 name/version may come from the server, so the
        // facilitator rebuilds the same digest. Chain and token stay pinned.
        name: String(parsed.requirement.extra?.name || CONTRACT.eip712DomainName),
        version: String(parsed.requirement.extra?.version || CONTRACT.eip712DomainVersion),
        chainId: BASE_CHAIN_ID,
        verifyingContract: USDC_BASE_ASSET,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: String(parsed.requirement.payTo).toLowerCase(),
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
    });

    const paymentPayload = {
      x402Version: 2,
      scheme: "exact",
      network: parsed.requirement.network,
      accepted: parsed.requirement,
      payer: account.address.toLowerCase(),
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: String(parsed.requirement.payTo).toLowerCase(),
          value: amount.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };

    const paymentSignature = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetchWithTimeout(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "PAYMENT-SIGNATURE": paymentSignature,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      text = await response.text();
      let retryBody = null;
      try {
        retryBody = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const retryCode = retryBody?.error?.code || retryBody?.code;
      if (response.status !== 503 || retryCode !== "forward_pending" || attempt === 2) break;
      const retryAfter = Number(response.headers.get("retry-after") || 2);
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 1), 15) * 1000));
    }
  } catch (err) {
    await rollback(reservation.reservation_id, "signing_or_transport_failed");
    throw err;
  }

  const txPrefix = settlementPrefix(response.headers.get("payment-response"));

  const responseBody = tryParse(text);
  const responseCode = responseBody?.error?.code || responseBody?.code;
  const preSettlementFailure = !txPrefix && [
    "backend_unavailable",
    "at_capacity",
    "facilitator_busy",
    "facilitator_misconfigured",
    "facilitator_auth_misconfigured",
  ].includes(responseCode);

  if (preSettlementFailure) {
    await rollback(reservation.reservation_id, responseCode);
  } else if (response.ok) {
    await commit(reservation.reservation_id, { txPrefix });
  } else {
    // A non-2xx answer means the service did not deliver what we paid for. The
    // facilitator may still have settled, so this is recorded rather than
    // silently freed: "rejected_after_signing" keeps the user's ledger honest.
    await commit(reservation.reservation_id, { txPrefix, status: `rejected_after_signing:${response.status}` });
  }

  const parsedBody = responseBody;
  const result = {
    ok: response.ok,
    paid: !preSettlementFailure,
    status: response.status,
    amount_atomic: amount.toString(),
    payer: account.address,
    tx_prefix: txPrefix,
    body: parsedBody,
  };
  if (walletWarning) result.warning = walletWarning;
  if (!response.ok) {
    result.code = classifyPaymentFailure(response.status, parsedBody);
    result.message = describePaymentFailure(result.code, response.status, parsedBody);
  }
  return result;
}

function classifyPaymentFailure(status, body) {
  const serverCode = String(body?.error?.code || body?.code || "").toLowerCase();
  if (serverCode) {
    return serverCode;
  }
  if (status === 402) {
    if (serverCode.includes("insufficient") || serverCode.includes("balance")) return "wallet_needs_usdc";
    return "payment_not_accepted";
  }
  if (status === 401 || status === 403) return "payment_not_accepted";
  if (status === 429) return "too_many_connections";
  if (status >= 500) return "service_unhealthy";
  return "request_rejected";
}

function describePaymentFailure(code, status, body) {
  const detail = body?.error?.message || body?.message || `HTTP ${status}`;
  switch (code) {
    case "wallet_needs_usdc":
      return `The payment could not settle, which usually means the buyer wallet has no USDC on Base. Service said: ${detail}`;
    case "payment_not_accepted":
      return `The service rejected the signed payment. Service said: ${detail}`;
    case "too_many_connections":
      return `The service is rate limiting this wallet. Service said: ${detail}`;
    case "service_unhealthy":
      return `The service returned a server error. Service said: ${detail}`;
    default:
      return `The request was rejected. Service said: ${detail}`;
  }
}
