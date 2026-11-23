import { readFileSync } from "node:fs";
import { PHOENIX_URL, phoenixUp, usePhoenixEnv } from "./env";
import { ensureAnnotationConfig } from "./rest";

/*
 * One-off Phoenix setup (no API cost): the annotation config for Edgar's verdicts, and one pass / fail
 * config per failure mode in ../failure-modes.json (E11), named by mode id.
 *
 *   npm run phoenix:setup
 */

usePhoenixEnv();
if (!(await phoenixUp(PHOENIX_URL))) throw new Error(`Phoenix is not reachable at ${PHOENIX_URL}; start private/phoenix/serve.sh`);
await ensureAnnotationConfig("edgar_verdict", ["pass", "fail", "defer"]);
console.log("annotation config edgar_verdict: pass, fail, defer");
const modes: { id: string }[] = JSON.parse(readFileSync(new URL("../failure-modes.json", import.meta.url), "utf8"));
for (const m of modes) await ensureAnnotationConfig(m.id, ["pass", "fail"]);
console.log(`annotation configs ${modes.map((m) => m.id).join(", ")}: pass, fail`);
