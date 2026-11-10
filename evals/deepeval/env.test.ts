import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { assertDeepEvalEnv, DEEPEVAL_ENV, staleTelemetryPath } from "./env";

const PUBLIC = fileURLToPath(new URL("../..", import.meta.url));
const good = (): NodeJS.ProcessEnv => ({ ...DEEPEVAL_ENV });
const cwd = () => mkdtempSync(join(tmpdir(), "deepeval-env-"));

test("assertDeepEvalEnv accepts the plan's environment from public/", () => {
  expect(() => assertDeepEvalEnv(good(), PUBLIC)).not.toThrow();
});

test("assertDeepEvalEnv throws when OPENAI_API_KEY, CONFIDENT_API_KEY or TYPESAFE_API_KEY is set", () => {
  for (const k of ["OPENAI_API_KEY", "CONFIDENT_API_KEY", "TYPESAFE_API_KEY"]) {
    expect(() => assertDeepEvalEnv({ ...good(), [k]: "x" }, PUBLIC), k).toThrow(k);
    expect(() => assertDeepEvalEnv({ ...good(), [k]: "" }, PUBLIC), k).toThrow(k);
  }
  for (const k of ["TEMPERATURE", "DEEPEVAL_MODEL_THINKING", "DEEPEVAL_RESULTS_FOLDER", "DEEPEVAL_VERBOSE_MODE"])
    expect(() => assertDeepEvalEnv({ ...good(), [k]: "1" }, PUBLIC), k).toThrow(k);
});

test("assertDeepEvalEnv throws when telemetry is not opted out", () => {
  const { DEEPEVAL_TELEMETRY_OPT_OUT: _, ...rest } = good();
  expect(() => assertDeepEvalEnv(rest, PUBLIC)).toThrow("DEEPEVAL_TELEMETRY_OPT_OUT");
  expect(() => assertDeepEvalEnv({ ...good(), DEEPEVAL_TELEMETRY_OPT_OUT: "0" }, PUBLIC)).toThrow("DEEPEVAL_TELEMETRY_OPT_OUT");
  expect(() => assertDeepEvalEnv({ ...good(), DEEPEVAL_DISABLE_DOTENV: "0" }, PUBLIC)).toThrow("DEEPEVAL_DISABLE_DOTENV");
});

test("assertDeepEvalEnv throws on an absolute cache folder or one outside private/", () => {
  const folder = (v: string) => () => assertDeepEvalEnv({ ...good(), DEEPEVAL_CACHE_FOLDER: v }, PUBLIC);
  expect(folder(resolve(PUBLIC, "../private/evals/.deepeval"))).toThrow("relative");
  expect(folder(".deepeval")).toThrow("DEEPEVAL_CACHE_FOLDER");
  expect(folder("private/evals/.deepeval")).toThrow("DEEPEVAL_CACHE_FOLDER"); // would land in public/private/...
  expect(folder("../public/.deepeval")).toThrow("DEEPEVAL_CACHE_FOLDER");
  expect(folder("../private/.deepeval")).toThrow("DEEPEVAL_CACHE_FOLDER");
});

test("assertDeepEvalEnv throws when a .deepeval keystore exists in cwd", () => {
  const dir = cwd();
  mkdirSync(join(dir, "public"));
  expect(() => assertDeepEvalEnv(good(), join(dir, "public"))).not.toThrow();
  mkdirSync(join(dir, "public/.deepeval"));
  writeFileSync(join(dir, "public/.deepeval/.deepeval"), "{}");
  expect(() => assertDeepEvalEnv(good(), join(dir, "public"))).toThrow("keystore");

  const other = cwd();
  mkdirSync(join(other, "public"));
  mkdirSync(join(other, "private/evals/.deepeval"), { recursive: true });
  writeFileSync(join(other, "private/evals/.deepeval/.deepeval"), "{}"); // where HIDDEN_DIR points the keystore
  expect(() => assertDeepEvalEnv(good(), join(other, "public"))).toThrow("keystore");
});

test("the npm package's stale dist/telemetry.js is removed (postinstall), so telemetry/index.js loads", () => {
  expect(existsSync(staleTelemetryPath())).toBe(false);
});

const SKIP = new Set(["node_modules", ".git"]);
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (SKIP.has(n) ? [] : statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

test("only evals/deepeval/env.ts imports deepeval", () => {
  const pkg = "deep" + "eval"; // not spelled out, so this file does not match itself
  // Value imports and dynamic imports; `import type` is erased at runtime and allowed under evals/deepeval/.
  const value = new RegExp(`(?:^|\\n)\\s*(?:import|export)(?!\\s+type\\b)[^;]*?from\\s+["']${pkg}(?:/[^"']*)?["']|import\\(\\s*["']${pkg}`);
  const typeOnly = new RegExp(`(?:import|export)\\s+type\\b[^;]*?from\\s+["']${pkg}(?:/[^"']*)?["']`);
  const hits = files(PUBLIC).filter((p) => /\.(ts|js|mjs|cjs)$/.test(p));
  const offenders: string[] = [];
  for (const p of hits) {
    const rel = relative(PUBLIC, p).replaceAll("\\", "/");
    const src = readFileSync(p, "utf8");
    if (rel === "evals/deepeval/env.ts") continue;
    if (value.test(src)) offenders.push(rel);
    if (typeOnly.test(src) && !rel.startsWith("evals/deepeval/")) offenders.push(`${rel} (type import outside evals/deepeval/)`);
  }
  expect(offenders).toEqual([]);
  expect(value.test(readFileSync(join(PUBLIC, "evals/deepeval/env.ts"), "utf8"))).toBe(true);
});
