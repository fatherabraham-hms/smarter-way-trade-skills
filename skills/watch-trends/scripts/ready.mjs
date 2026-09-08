#!/usr/bin/env node
/**
 * Prerequisite gate for /watch-trends. Spends nothing and touches no network.
 *
 * Usage: node scripts/ready.mjs
 */

import { emit, run } from "./lib/output.mjs";
import { emitReadyFields, inspectReady } from "./lib/ready.mjs";

const STAGE = "ready";

run(STAGE, async () => {
  const result = inspectReady();
  emit({
    ok: result.ok,
    stage: STAGE,
    code: result.code,
    ...emitReadyFields(result),
  });
});
