import {
  context, OpenInferenceSpanKind, SemanticConventions, setSession, SpanStatusCode, trace,
} from "@arizeai/phoenix-otel";
import type { CheckResult, EvalCase } from "../../src/types";
import { checkFamily } from "../checks";
import type { RunHeader } from "../results";
import type { CaseRun, LoadedCase } from "../run";

/*
 * Spans for eval runs (phoenix-review.md 2.2). One CHAIN span `case` per case and repeat, around
 * runCase(), so the Anthropic SDK's own LLM span (content mode, with the raw text and any blocked
 * sentence) nests under it; one GUARDRAIL child per check family with its name and pass only.
 * The case span never carries raw model text: that lives only in the SDK span, in the local Phoenix.
 * Spans go to the global tracer provider (runExperiment's, or the one the dry run registers).
 */

export type SpanAttributes = Record<string, string | number | boolean>;

const { OPENINFERENCE_SPAN_KIND, INPUT_VALUE, INPUT_MIME_TYPE, OUTPUT_VALUE, OUTPUT_MIME_TYPE, METADATA, SESSION_ID } = SemanticConventions;
const tracer = () => trace.getTracer("career-agent-evals");

/** "ru" when the question has a Cyrillic word (and no Armenian letter), as the `lang` check decides; else "en". */
export const caseLanguage = (c: Pick<EvalCase, "question">): "ru" | "en" =>
  !/\p{Script=Armenian}/u.test(c.question) && /\p{Script=Cyrillic}{2,}/u.test(c.question) ? "ru" : "en";

export function caseSpanAttributes(run: CaseRun, c: LoadedCase, h: RunHeader): SpanAttributes {
  const r = run.result;
  const fallback = r.events.find((e) => e.type === "fallback");
  const metadata = {
    caseId: c.id, category: c.category, language: caseLanguage(c), source: r.source, model: r.model, rep: r.rep,
    promptHash: h.promptHash, corpusHash: h.corpusHash, judges: h.judges.map((j) => j.id), isPrivate: c.isPrivate, gitSha: h.gitSha,
  };
  return {
    [INPUT_VALUE]: JSON.stringify({ question: run.question, history: run.history }),
    [INPUT_MIME_TYPE]: "application/json",
    [OUTPUT_VALUE]: r.reply ?? "",
    [OUTPUT_MIME_TYPE]: "text/plain",
    [METADATA]: JSON.stringify(metadata),
    "agent.sentences": JSON.stringify(r.events.flatMap((e) => (e.type === "sentence" ? [{ text: e.text, sources: e.sources }] : []))),
    ...(fallback ? { "agent.fallback.reason": fallback.reason, ...(fallback.detail ? { "agent.fallback.detail": fallback.detail } : {}) } : {}),
    "agent.cost_usd": +run.spend.costUsd.toFixed(6),
  };
}

/**
 * Runs fn inside the `case` span; attrs(result) is set on it when fn resolves. A multi-turn case
 * passes its session id, so Phoenix's session view groups it. A thrown error marks the span ERROR
 * without its message (it could carry case text).
 */
export function withCaseSpan<T>(attrs: (result: T) => SpanAttributes, fn: () => Promise<T>, sessionId?: string): Promise<T> {
  const ctx = sessionId ? setSession(context.active(), { sessionId }) : context.active();
  const base = { [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN, ...(sessionId ? { [SESSION_ID]: sessionId } : {}) };
  return tracer().startActiveSpan("case", { attributes: base }, ctx, async (span) => {
    try {
      const result = await fn();
      span.setAttributes(attrs(result));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** One GUARDRAIL span per check family under the active span: the family name and pass or fail, never a reason. */
export function recordGuardrails(checks: CheckResult[]): void {
  const families = new Map<string, boolean>();
  for (const k of checks) families.set(checkFamily(k.name), (families.get(checkFamily(k.name)) ?? true) && k.pass);
  for (const [name, pass] of families)
    tracer()
      .startSpan(name, { attributes: { [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.GUARDRAIL, [OUTPUT_VALUE]: pass ? "pass" : "fail" } })
      .end();
}

/** The active span's trace id: inside an experiment task, the task span's trace. Null when no provider records spans. */
export function activeTraceId(): string | null {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && trace.isSpanContextValid(ctx) ? ctx.traceId : null;
}
