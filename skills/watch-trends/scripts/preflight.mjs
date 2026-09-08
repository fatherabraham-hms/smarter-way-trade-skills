#!/usr/bin/env node
/**
 * Host preflight. Spends nothing and touches no network.
 *
 * Thin wrapper around the shared ready gate. Prefer `node scripts/ready.mjs`
 * from /watch-trends; this name remains so older docs and agents still work.
 *
 * Usage: node scripts/preflight.mjs
 */

import { emit, run } from "./lib/output.mjs";
import { emitReadyFields, inspectReady } from "./lib/ready.mjs";

const STAGE = "preflight";

run(STAGE, async () => {
  const result = inspectReady();
  emit({
    ok: result.ok,
    stage: STAGE,
    code: result.code,
    ...emitReadyFields(result),
  });
});
