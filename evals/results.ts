import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT } from "../src/prompt";
import type { AgentEvent, CaseResult, EvalCase, Msg, Turn } from "../src/types";
import type { CaseRun, LoadedCase } from "./run";

/*
 * Results files. Every run writes two:
 *  - ../private/evals/results/<stamp>.json (gitignored): every run in full, with rawText (the model's
 *    raw text, including blocked sentences).
 *  - evals/results/<stamp>.json (gitignored): public runs without rawText; private runs only as
 *    id, category and pass.
 * Labels join runs on traceId, or on (caseId, model, rep) when traceId is null.
 */

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = { publicDir: join(PUBLIC_ROOT, "evals/results"), privateDir: resolve(PUBLIC_ROOT, "../private/evals/results") };

/** One judge used by a run, as the header records it. */
export type JudgeHeader = { id: string; model: string; promptHash: string };
export type RunHeader = {
  model: string;
  agent: "real" | "stub";
  startedAt: string;
  repeat: number;
  only: EvalCase["category"] | null;
  ids: string[] | null;
  subset: "all" | "pr" | "golden";
  judgeSkipped: boolean;
  incomplete: boolean;
  stoppedForBudget: boolean;
  costUsd: number;
  judgeCostUsd: number;
  promptHash: string;
  corpusHash: string;
  caseSetVersion: string;
  sdkVersions: { anthropic: string; deepeval: string | null; phoenixClient: string | null; phoenixOtel: string | null; node: string };
  judges: JudgeHeader[];
  gitSha: string;
  experimentId?: string;
};
export type StoredRun = {
  id: string;
  category: EvalCase["category"];
  source: CaseResult["source"];
  slice?: EvalCase["slice"];
  rep: number;
  model: string;
  traceId: string | null;
  question: string;
  history: Msg[];
  followUps: string[];
  reply: string;
  turns: Turn[];
  events: CaseResult["events"];
  checks: CaseResult["checks"];
  pass: boolean;
  latencyMs: CaseResult["latencyMs"];
  spend: CaseRun["spend"];
  rawText?: string;
  /** Private file only. */
  isPrivate?: boolean;
};
export type Redacted = Pick<CaseResult, "id" | "category" | "pass">;
export type ResultsFile = { header: RunHeader; runs: StoredRun[] };

export const sha12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** What may be written under public/ or logged for a private case: no reply text, no reasons. */
export const redact = (r: CaseResult): Redacted => ({ id: r.id, category: r.category, pass: r.pass });

/** Hash of every loaded case (as its JSON line), sorted by id. */
export function caseSetVersion(cases: LoadedCase[]): string {
  const lines = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ isPrivate: _, ...c }) => JSON.stringify(c));
  return sha12(lines.join("\n"));
}

const pkgVersion = (name: string): string | null => {
  try {
    return JSON.parse(readFileSync(join(PUBLIC_ROOT, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PUBLIC_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export function buildHeader(o: {
  model: string;
  agent: "real" | "stub";
  startedAt: string;
  repeat: number;
  only: EvalCase["category"] | null;
  ids: string[] | null;
  judgeSkipped: boolean;
  incomplete: boolean;
  stoppedForBudget: boolean;
  costUsd: number;
  judgeCostUsd: number;
  career: string;
  cases: LoadedCase[];
  judges: JudgeHeader[];
  system?: string;
}): RunHeader {
  const { career, cases, judges, system, ...rest } = o;
  return {
    ...rest,
    subset: "all",
    promptHash: sha12(system ?? SYSTEM_PROMPT),
    corpusHash: sha12(career),
    caseSetVersion: caseSetVersion(cases),
    sdkVersions: {
      anthropic: pkgVersion("@anthropic-ai/sdk") ?? "unknown",
      deepeval: pkgVersion("deepeval"),
      phoenixClient: pkgVersion("@arizeai/phoenix-client"),
      phoenixOtel: pkgVersion("@arizeai/phoenix-otel"),
      node: process.version,
    },
    judges,
    gitSha: gitSha(),
  };
}

/** Stored costs are rounded to 6 decimals, so long digit runs never reach the files (or the blocklist scan). */
const usd = (x: number) => +x.toFixed(6);
const roundCost = (e: AgentEvent): AgentEvent => (e.type === "done" ? { ...e, costUsd: usd(e.costUsd) } : e);

/**
 * The view every scorer must take of a run: the last turn's question, and the history before it (the seed
 * history, then each earlier turn's question and visible reply), exactly what run.ts gives the gate judge.
 * A run's `question` is the first question and its `reply` the last turn's, so pairing those is wrong for a
 * multi-turn case. Mirrored in private/evals/py/runs.py (load_runs). `rawText` joins every turn's raw text,
 * so raw-text scores are not last-turn views for multi-turn cases.
 */
export function lastTurnView(r: { question: string; history: Msg[]; turns?: Turn[] }): { question: string; history: Msg[] } {
  const turns = r.turns ?? [];
  if (!turns.length) return { question: r.question, history: r.history };
  return {
    question: turns.at(-1)!.question,
    history: [...r.history, ...turns.slice(0, -1).flatMap((t): Msg[] => [{ role: "user", text: t.question }, { role: "assistant", text: t.reply }])],
  };
}

export function toStored(run: CaseRun): StoredRun {
  const r = run.result;
  const turns = r.turns ?? [];
  return {
    id: r.id,
    category: r.category,
    source: r.source,
    slice: r.slice,
    rep: r.rep,
    model: r.model,
    traceId: r.traceId,
    question: run.question,
    history: run.history,
    followUps: turns.slice(1).map((t) => t.question),
    reply: r.reply ?? "",
    turns: turns.map((t) => ({ ...t, events: t.events.map(roundCost) })),
    events: r.events.map(roundCost),
    checks: r.checks,
    pass: r.pass,
    latencyMs: r.latencyMs,
    spend: { ...run.spend, costUsd: usd(run.spend.costUsd), judgeCostUsd: usd(run.spend.judgeCostUsd) },
    rawText: run.rawText,
  };
}

export function writeResults(
  stamp: string,
  header: RunHeader,
  runs: CaseRun[],
  isPrivate: (id: string) => boolean,
  dirs = DIRS,
): { publicPath: string; privatePath: string } {
  const publicPath = join(dirs.publicDir, `${stamp}.json`);
  const privatePath = join(dirs.privateDir, `${stamp}.json`);
  const pub = runs.map((run) => {
    if (isPrivate(run.result.id)) return redact(run.result);
    const { rawText: _, ...rest } = toStored(run);
    return rest;
  });
  const priv = runs.map((run) => ({ ...toStored(run), isPrivate: isPrivate(run.result.id) }));
  mkdirSync(dirs.privateDir, { recursive: true });
  writeFileSync(privatePath, JSON.stringify({ header, runs: priv }, null, 2));
  mkdirSync(dirs.publicDir, { recursive: true });
  writeFileSync(publicPath, JSON.stringify({ header, runs: pub }, null, 2));
  return { publicPath, privatePath };
}
