import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentEvent, CaseResult, CheckResult, EvalCase, Usage } from "../src/types";
import { judge as realJudge } from "./judge";
import { gates, handedOff, scoreDeterministic, type Gates } from "./score";

/*
 * Eval runner.
 *
 *   npm run evals -- --model <id> --cases <dir...> [--repeat n] [--only category]
 *                    [--agent <module>] [--no-judge]
 *
 * The agent is injected: an AgentFn takes a case (question and optional history) and yields the
 * same AgentEvents the production Worker streams. `--agent` names a module whose export
 * `makeAgent(model: string): AgentFn` builds it; the default is src/eval-agent.ts, which runs
 * answer() with a real Anthropic client (the SDK reads ANTHROPIC_API_KEY itself), career.md and
 * ../private/blocklist.json. Tests and stub runs call runCases() directly with a stub.
 *
 * Each case prints its token usage and cost (agent and judge), and the run prints totals.
 *
 * Running the real agent or the judge calls a paid model. Get Edgar's cost approval first.
 * Use --no-judge to skip rubric cases (recorded as judgeSkipped) for a cheaper partial run.
 *
 * Output:
 *  - evals/results/<timestamp>.json (gitignored): gates, and every case. Cases loaded from the
 *    private directory appear only as id, category and pass.
 *  - ../private/evals/results/<timestamp>.json: full detail (replies, reasons) for private cases.
 *  - The console never shows question or reply text for private cases, only ids and pass or fail.
 */

export type AgentFn = (c: EvalCase) => AsyncIterable<AgentEvent>;
export type JudgeFn = (c: EvalCase, reply: string) => Promise<CheckResult & { costUsd?: number }>;
export type LoadedCase = EvalCase & { isPrivate: boolean };

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = resolve(HERE, "..");
const PRIVATE_ROOT = resolve(PUBLIC_ROOT, "../private");
export const CATEGORIES: EvalCase["category"][] = [
  "facts", "conflicts", "fit", "not_in_corpus", "confidential", "attacks", "commitments", "recruiter", "tone",
];

export function loadCases(dirs: string[]): LoadedCase[] {
  const cases: LoadedCase[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const abs = resolve(dir);
    const isPrivate = abs === PRIVATE_ROOT || abs.startsWith(PRIVATE_ROOT + sep);
    for (const name of readdirSync(abs).filter((f) => f.endsWith(".jsonl")).sort()) {
      readFileSync(join(abs, name), "utf8").split("\n").forEach((line, i) => {
        if (!line.trim()) return;
        const where = `${name}:${i + 1}`; // never includes case text
        let c: EvalCase;
        try {
          c = JSON.parse(line);
        } catch {
          throw new Error(`${where}: invalid JSON`);
        }
        if (typeof c.id !== "string" || typeof c.question !== "string" || !CATEGORIES.includes(c.category))
          throw new Error(`${where}: needs string id, string question and a known category`);
        if (seen.has(c.id)) throw new Error(`${where}: duplicate id`);
        seen.add(c.id);
        cases.push({ ...c, isPrivate });
      });
    }
  }
  return cases;
}

export type RunOptions = {
  agent: AgentFn;
  /** Omit to skip rubric cases. */
  judge?: JudgeFn;
  repeat?: number;
  only?: EvalCase["category"];
  onResult?: (r: CaseResult, c: LoadedCase, spend: CaseSpend) => void;
};
export type CaseSpend = { usage?: Usage; costUsd: number; judgeCostUsd: number };
export type RunOutput = { results: CaseResult[]; costUsd: number; judgeCostUsd: number; judgeSkipped: boolean };

export async function runCases(cases: LoadedCase[], opts: RunOptions): Promise<RunOutput> {
  const results: CaseResult[] = [];
  let costUsd = 0;
  let judgeCostUsd = 0;
  let judgeSkipped = false;
  const selected = opts.only ? cases.filter((c) => c.category === opts.only) : cases;
  for (let rep = 0; rep < (opts.repeat ?? 1); rep++) {
    for (const c of selected) {
      const events: AgentEvent[] = [];
      try {
        for await (const e of opts.agent(c)) events.push(e);
      } catch {
        events.push({ type: "fallback", reason: "api_error" }); // detail omitted: it could echo private text
      }
      const spend: CaseSpend = { costUsd: 0, judgeCostUsd: 0 };
      for (const e of events)
        if (e.type === "done") {
          spend.usage = e.usage;
          spend.costUsd += e.costUsd;
        }
      const reply = events.flatMap((e) => (e.type === "sentence" ? [e.text] : [])).join(" ");
      const checks = scoreDeterministic(c, reply, events);
      if (c.judge) {
        if (opts.judge) {
          try {
            const { costUsd: jc = 0, ...j } = await opts.judge(c, reply);
            spend.judgeCostUsd += jc;
            checks.push(c.isPrivate ? { name: j.name, pass: j.pass, ...(j.pass ? {} : { reason: "judge failed" }) } : j);
          } catch {
            checks.push({ name: "judge", pass: false, reason: "judge call failed" });
          }
        } else judgeSkipped = true;
      }
      const r: CaseResult = {
        id: c.id,
        category: c.category,
        pass: checks.every((k) => k.pass),
        checks,
        fellBack: events.some((e) => e.type === "fallback"),
        handedOff: handedOff(reply, events),
        reply,
      };
      results.push(r);
      costUsd += spend.costUsd;
      judgeCostUsd += spend.judgeCostUsd;
      opts.onResult?.(r, c, spend);
    }
  }
  return { results, costUsd, judgeCostUsd, judgeSkipped };
}

/** What may be written under public/ or logged for a private case: no reply text, no reasons. */
export const redact = (r: CaseResult): Pick<CaseResult, "id" | "category" | "pass"> => ({
  id: r.id,
  category: r.category,
  pass: r.pass,
});

/**
 * A run that skipped the judge or covered one category checked only part of the gates, so it can
 * never pass: it prints INCOMPLETE and exits 1. Nothing here writes baseline.json; a baseline
 * must be recorded by hand from a complete run.
 */
export function gateSummary(g: Gates, incomplete: boolean): { line: string; exitCode: number } {
  const detail =
    `invented=${g.invented} leaks=${g.leaks} ` +
    `attackBlockRate=${g.attackBlockRate.toFixed(3)} falseRefusalRate=${g.falseRefusalRate.toFixed(3)}`;
  if (incomplete) return { line: `gates: INCOMPLETE (judge skipped or --only set; not a pass) ${detail}`, exitCode: 1 };
  return { line: `gates: ${g.passed ? "PASS" : "FAIL"} ${detail}`, exitCode: g.passed ? 0 : 1 };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      cases: { type: "string", multiple: true },
      repeat: { type: "string" },
      only: { type: "string" },
      agent: { type: "string" },
      "no-judge": { type: "boolean" },
    },
  });
  const dirs = [...(values.cases ?? []), ...positionals];
  const only = values.only as EvalCase["category"] | undefined;
  const repeat = Number(values.repeat ?? 1);
  if (!values.model || !dirs.length || !Number.isInteger(repeat) || repeat < 1 || (only && !CATEGORIES.includes(only))) {
    console.error("Usage: npm run evals -- --model <id> --cases <dir...> [--repeat n] [--only category] [--agent <module>] [--no-judge]");
    process.exit(1);
  }

  // Needs --agent <module exporting makeAgent(model): AgentFn>, or src/eval-agent.ts from Task 6.
  const mod = await import(pathToFileURL(resolve(values.agent ?? "src/eval-agent.ts")).href);
  const agent: AgentFn = mod.makeAgent(values.model);

  const cases = loadCases(dirs);
  const byId = new Map(cases.map((c) => [c.id, c]));
  const { results, costUsd, judgeCostUsd, judgeSkipped } = await runCases(cases, {
    agent,
    judge: values["no-judge"] ? undefined : realJudge,
    repeat,
    only,
    onResult: (r, c, s) => {
      const u = s.usage;
      const tokens = u ? `in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}` : "no usage";
      console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id}  ${tokens}  $${s.costUsd.toFixed(5)} judge $${s.judgeCostUsd.toFixed(5)}`);
      if (!r.pass && !c.isPrivate)
        for (const k of r.checks.filter((k) => !k.pass)) console.log(`  ${k.name}: ${k.reason ?? ""}`);
    },
  });

  const g = gates(results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const incomplete = judgeSkipped || !!only;
  const header = { model: values.model, startedAt: new Date().toISOString(), repeat, only: only ?? null, judgeSkipped, incomplete, costUsd, judgeCostUsd, gates: g };
  const isPriv = (r: CaseResult) => byId.get(r.id)?.isPrivate;

  const pubDir = join(PUBLIC_ROOT, "evals/results");
  mkdirSync(pubDir, { recursive: true });
  writeFileSync(
    join(pubDir, `${stamp}.json`),
    JSON.stringify({ ...header, results: results.map((r) => (isPriv(r) ? redact(r) : r)) }, null, 2),
  );
  if (results.some(isPriv)) {
    const privDir = join(PRIVATE_ROOT, "evals/results");
    mkdirSync(privDir, { recursive: true });
    writeFileSync(join(privDir, `${stamp}.json`), JSON.stringify({ ...header, results: results.filter(isPriv) }, null, 2));
  }

  const n = results.filter((r) => r.pass).length;
  console.log(
    `\n${n}/${results.length} passed. cost: agent $${costUsd.toFixed(4)} + judge $${judgeCostUsd.toFixed(4)} = $${(costUsd + judgeCostUsd).toFixed(4)}` +
      ` (agent $${(costUsd / Math.max(results.length, 1)).toFixed(5)} per case)${judgeSkipped ? " (rubric checks skipped)" : ""}`,
  );
  const { line, exitCode } = gateSummary(g, incomplete);
  console.log(line);
  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
