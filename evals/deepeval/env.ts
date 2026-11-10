import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/*
 * The only module that imports DeepEval (TS SDK, devDependency, never imported by the Worker).
 * loadDeepEval() sets the environment block from the eval-program plan, asserts it, then imports.
 * The order matters: DeepEval reads DEEPEVAL_CACHE_FOLDER once at import (constants.ts HIDDEN_DIR) and
 * joins it onto the cwd, so the folder must be relative, and it must resolve to private/evals/.deepeval.
 * Metrics run through metric.measure() only (no evaluate(), so no cache or test-run file is written);
 * the cache folder is set anyway as a guard. Never run `deepeval login|view|gate|set-*`.
 */

export const DEEPEVAL_ENV: Record<string, string> = {
  DEEPEVAL_TELEMETRY_OPT_OUT: "1",
  DEEPEVAL_DISABLE_DOTENV: "1",
  DEEPEVAL_EVAL_MODE: "llm",
  DEEPEVAL_CACHE_FOLDER: "../private/evals/.deepeval",
  USE_ANTHROPIC_MODEL: "1",
  ANTHROPIC_MODEL_NAME: "claude-sonnet-5-5",
};
/** Must be absent: keys that would route a metric to OpenAI, Confident AI or TypeSafe, and settings that change judge calls, write results or print verbose logs (they quote case text). */
const UNSET = ["OPENAI_API_KEY", "CONFIDENT_API_KEY", "TYPESAFE_API_KEY", "TEMPERATURE", "DEEPEVAL_MODEL_THINKING", "DEEPEVAL_RESULTS_FOLDER", "DEEPEVAL_VERBOSE_MODE"];
const CACHE_TAIL = join("private", "evals", ".deepeval");
const KEY_FILE = ".deepeval"; // DeepEval's keystore: <cwd>/<HIDDEN_DIR>/.deepeval (config/keystore.ts)

export function assertDeepEvalEnv(env: NodeJS.ProcessEnv, cwd: string): void {
  for (const [k, v] of Object.entries(DEEPEVAL_ENV))
    if (k !== "DEEPEVAL_CACHE_FOLDER" && env[k] !== v) throw new Error(`DeepEval env: ${k} must be ${v}`);
  for (const k of UNSET) if (env[k] !== undefined) throw new Error(`DeepEval env: ${k} must be unset`);
  const folder = env.DEEPEVAL_CACHE_FOLDER;
  if (!folder) throw new Error("DeepEval env: DEEPEVAL_CACHE_FOLDER must be set");
  if (isAbsolute(folder)) throw new Error("DeepEval env: DEEPEVAL_CACHE_FOLDER must be relative (DeepEval joins it onto the cwd)");
  const abs = resolve(cwd, folder);
  if (!abs.endsWith(sep + CACHE_TAIL) || !relative(cwd, abs).startsWith(".."))
    throw new Error(`DeepEval env: DEEPEVAL_CACHE_FOLDER must resolve to ${CACHE_TAIL} outside the cwd`);
  for (const dir of [join(cwd, ".deepeval"), abs])
    if (existsSync(join(dir, KEY_FILE))) throw new Error(`DeepEval env: a .deepeval keystore exists at ${relative(cwd, join(dir, KEY_FILE))}; remove it`);
}

const require = createRequire(import.meta.url);
/**
 * npm deepeval@0.9.25 ships a stale dist/telemetry.js (not in the vendored source) that shadows
 * dist/telemetry/index.js for `require("../telemetry")`; it needs @sentry/node and carries old
 * PostHog, New Relic and Sentry telemetry. The postinstall script in package.json deletes it.
 */
export const staleTelemetryPath = () => join(dirname(require.resolve("deepeval")), "telemetry.js");

export type DeepEval = typeof import("deepeval") & { models: typeof import("deepeval/models") };
let loaded: Promise<DeepEval> | undefined;

export function loadDeepEval(): Promise<DeepEval> {
  loaded ??= (async () => {
    for (const k of UNSET) delete process.env[k];
    Object.assign(process.env, DEEPEVAL_ENV);
    assertDeepEvalEnv(process.env, process.cwd());
    if (existsSync(staleTelemetryPath())) throw new Error("deepeval: stale dist/telemetry.js present; run npm install (postinstall removes it)");
    const [root, models] = await Promise.all([import("deepeval"), import("deepeval/models")]);
    return { ...root, models };
  })();
  return loaded;
}
