/**
 * Structured, redacted output.
 *
 * Every script emits exactly one JSON object on stdout so an agent can act on
 * it without parsing prose. Human-readable narration goes to stderr, which
 * keeps stdout machine-parseable even when a script is chatty.
 *
 * Redaction is enforced here rather than at each call site so that a new script
 * cannot accidentally leak a secret it forgot to mask.
 */

import { USDC_DECIMALS } from "./constants.mjs";

/** Env var names whose values must never appear in output. */
const SECRET_ENV_NAMES = [
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  "CB_AGENT_KIT_CLIENT_API_KEY",
  "CB_AGENT_KIT_CLIENT_SECRET",
  "CB_AGENT_KIT_WALLET_SECRET",
  "TELEGRAM_BOT_TOKEN",
];

/** Header names that carry payment material and must never be printed. */
export const FORBIDDEN_HEADERS = ["payment-signature", "payment-response", "authorization", "cookie"];

/**
 * Reduce a sensitive string to a short prefix. Six characters is enough to
 * correlate two log lines and far too little to replay anything.
 */
export function mask(value, keep = 6) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  if (!str) return null;
  if (str.length <= keep) return `${str.slice(0, 2)}...`;
  return `${str.slice(0, keep)}...`;
}

/** Collect the live values of known secrets so scrub() can strip them. */
function currentSecretValues() {
  const values = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name];
    if (v && v.length >= 8) values.push(v);
  }
  return values;
}

/**
 * Strip any literal secret value that made it into a payload, at any depth.
 * This is a backstop: the scripts are written not to include secrets at all.
 */
export function scrub(value, extraSecrets = []) {
  const secrets = [...currentSecretValues(), ...extraSecrets.filter((s) => s && String(s).length >= 8)];
  const replace = (str) => {
    let out = str;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out;
  };

  const walk = (node) => {
    if (typeof node === "string") return replace(node);
    if (typeof node === "bigint") return node.toString();
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_HEADERS.includes(k.toLowerCase())) {
          out[k] = "[redacted]";
          continue;
        }
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };

  return walk(value);
}

/** Format atomic USDC as a dollar string, e.g. 10000n -> "0.010000". */
export function formatUsdc(atomic) {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : BigInt(atomic);
  const str = abs.toString().padStart(USDC_DECIMALS + 1, "0");
  const whole = str.slice(0, -USDC_DECIMALS);
  const frac = str.slice(-USDC_DECIMALS);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Format atomic USDC for humans, e.g. 10000n -> "$0.01". */
export function formatDollars(atomic) {
  const value = Number(BigInt(atomic)) / 10 ** USDC_DECIMALS;
  return `$${value.toFixed(value < 1 ? 4 : 2).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

/** Narration for humans. Never carries structured data an agent must parse. */
export function note(message) {
  process.stderr.write(`${message}\n`);
}

let emitted = false;

/**
 * Emit the single result object and exit. Calling twice is a bug, so the
 * second call is dropped rather than producing unparseable double JSON.
 */
export function emit(result, { exitCode } = {}) {
  if (emitted) return;
  emitted = true;
  const payload = scrub({
    ok: Boolean(result.ok),
    stage: result.stage ?? null,
    code: result.code ?? (result.ok ? "ok" : "error"),
    ...result,
  });
  payload.ok = Boolean(result.ok);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  const finalCode = exitCode ?? (result.ok ? 0 : 1);
  process.exitCode = finalCode;
}

/** Emit a failure and exit non-zero. */
export function fail(stage, code, message, extra = {}) {
  emit({ ok: false, stage, code, message, ...extra });
  process.exit(1);
}

/** Emit a success and exit zero. */
export function succeed(stage, extra = {}) {
  emit({ ok: true, stage, code: "ok", ...extra });
  process.exit(0);
}

/** Wrap a main() so unexpected throws still produce parseable output. */
export function run(stage, main) {
  main().catch((err) => {
    fail(stage, "unexpected_error", err?.message || String(err), {
      next_action: "Report this diagnostic to the operator; no payment was completed by this failure path.",
    });
  });
}
