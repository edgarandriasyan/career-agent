import { PHOENIX_URL, phoenixUp, usePhoenixEnv } from "./env";
import { ensureAnnotationConfig } from "./rest";

/*
 * One-off Phoenix setup (no API cost): the annotation config for Edgar's verdicts. One pass / fail
 * config per failure mode is added after error discovery (E11).
 *
 *   npm run phoenix:setup
 */

usePhoenixEnv();
if (!(await phoenixUp(PHOENIX_URL))) throw new Error(`Phoenix is not reachable at ${PHOENIX_URL}; start private/phoenix/serve.sh`);
await ensureAnnotationConfig("edgar_verdict", ["pass", "fail", "defer"]);
console.log("annotation config edgar_verdict: pass, fail, defer");
