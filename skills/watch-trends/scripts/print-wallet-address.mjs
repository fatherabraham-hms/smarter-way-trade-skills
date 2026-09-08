#!/usr/bin/env node
/**
 * Resolve the dedicated buyer account and print ONLY its public address.
 *
 * The address is public information and safe to show. Nothing else about the
 * wallet is printed, and the user is never asked for a seed phrase or private
 * key: this script creates or looks up the account through CDP using
 * credentials that stay in their secret store.
 *
 * Usage: node scripts/print-wallet-address.mjs
 */

import { checkWalletIsolation, loadConfig } from "./lib/config.mjs";
import { getBuyerAccount, SkillError } from "./lib/cdp.mjs";
import { projectRun } from "./lib/costs.mjs";
import { emit, formatDollars, run } from "./lib/output.mjs";

const STAGE = "wallet";

run(STAGE, async () => {
  const config = loadConfig();

  const isolation = checkWalletIsolation(config.accountName, config.allowSharedWallet);
  if (isolation?.severity === "error") {
    emit({
      ok: false,
      stage: STAGE,
      code: isolation.code,
      message: isolation.message,
      account_name: config.accountName,
      next_action:
        "Tell the user this looks like their main trading wallet and that automated spending should come from a dedicated, " +
        "small-balance account. Do not set WATCHTRENDS_ALLOW_SHARED_WALLET yourself.",
    });
    process.exit(1);
  }

  let account;
  let warning = null;
  try {
    const resolved = await getBuyerAccount(config);
    account = resolved.account;
    warning = resolved.warning;
  } catch (err) {
    if (err instanceof SkillError) {
      emit({
        ok: false,
        stage: STAGE,
        code: err.code,
        message: err.message,
        ...err.extra,
        next_action:
          err.code === "cdp_credentials_missing"
            ? "Name the missing CDP_* variables, point the user at https://docs.cdp.coinbase.com/x402/buyer/quickstart, tell them to set the values in their runtime secret manager, then source the profile (Linux/macOS) or open a new terminal (Windows) and restart the agent. Never ask for the values in chat."
            : "Resolve the reported problem, then rerun this script.",
      });
      process.exit(1);
    }
    throw err;
  }

  const weekly = projectRun(1, 24).weekFundingAtomic;

  emit({
    ok: true,
    stage: STAGE,
    code: "ok",
    account_name: config.accountName,
    address: account.address,
    network: "base",
    asset: "USDC",
    funding_suggestion_usd: formatDollars(weekly),
    warning,
    next_action:
      `Ask the user to send a small amount of USDC on Base to ${account.address} — about ` +
      `${formatDollars(weekly)} covers a week of one continuous ticker. Tell them this address should hold nothing else, ` +
      "because its balance is the real limit on total spend. Confirm by asking whether they are done; never ask for a seed phrase or private key.",
  });
});
