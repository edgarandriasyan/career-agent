import type { Usage } from "./types";

/*
 * USD per million tokens. Source: the claude-api skill (Claude Code bundled skills 2.1.321):
 * SKILL.md "Current Models (cached: 2026-11-03)" for input and output. Haiku 5.5 cache rates:
 * shared/model-migration.md "Migrating to Claude Haiku 5.5" (reads 0.1x input, 5-minute writes
 * 1.25x). Sonnet 5.5 cache rates: shared/prompt-caching.md "Economics" (reads $0.10, 5-minute
 * writes 1.25x) and shared/models.md. Haiku 5.5 rates apply to
 * prompts up to 100K tokens; career.md is far below that. Re-check against the live pricing page
 * before relying on these for billing.
 */
const RATES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

export function costUsd(model: string, u: Usage): number {
  const r = RATES[model];
  if (!r) throw new Error(`no pricing for model ${model}`);
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite) / 1e6;
}
