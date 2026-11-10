import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", ".wrangler"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const rel = (p: string) => relative(ROOT, p);
const isTest = (p: string) => p.endsWith(".test.ts");
const importsOf = (p: string) => {
  const src = readFileSync(p, "utf8");
  return [...src.matchAll(/(?:import|export)[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
};

// eval-agent.ts is the eval-only entry (reads files, imports runner types); production never imports it.
// The Worker bundles src/; nothing there may pull in Node, DeepEval, Phoenix or eval code.
const src = files(join(ROOT, "src")).filter((p) => !isTest(p) && rel(p) !== "src/eval-agent.ts");

test("no src file except eval-agent.ts and *.test.ts imports node:*, deepeval or @arizeai", () => {
  for (const p of src) for (const i of importsOf(p)) expect(i, rel(p)).not.toMatch(/^node:|^deepeval|^@arizeai/);
});

test("src files may import from evals/ only evals/judges/request.ts and evals/judges/<spec>.ts", () => {
  for (const p of src)
    for (const i of importsOf(p).filter((i) => i.startsWith("."))) {
      const target = rel(join(p, "..", i)).replaceAll("\\", "/");
      if (target.startsWith("evals/")) expect(target, rel(p)).toMatch(/^evals\/judges\/[a-z0-9-]+$/);
    }
});

test("only files under evals/ mention the Anthropic OpenTelemetry content-mode variable", () => {
  const name = "ANTHROPIC_OPEN" + "_TELEMETRY";
  const outside = files(ROOT).filter((p) => /^(src|scripts)\//.test(rel(p)) && /\.(ts|js)$/.test(p) && !isTest(p));
  for (const p of outside) expect(readFileSync(p, "utf8"), rel(p)).not.toContain(name);
});

test("judge spec modules import nothing from node:*", () => {
  const judges = files(join(ROOT, "evals/judges")).filter((p) => !isTest(p));
  expect(judges.length).toBeGreaterThan(0);
  for (const p of judges) for (const i of importsOf(p)) expect(i, rel(p)).not.toMatch(/^node:/);
});
