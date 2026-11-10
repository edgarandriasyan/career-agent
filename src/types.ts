export type Msg = { role: "user" | "assistant"; text: string };
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type FallbackReason = "blocked" | "refusal" | "api_error" | "truncated";
export type AgentEvent =
  | { type: "sentence"; text: string; sources: string[] }
  | { type: "fallback"; reason: FallbackReason; detail?: string }
  | { type: "done"; usage: Usage; costUsd: number; model: string };
export type CaseSource = "handwritten" | "tuple" | "deepeval-synth" | "simulated" | "ablation" | "production";
export type EvalCase = {
  id: string;
  category: "facts" | "conflicts" | "fit" | "not_in_corpus" | "confidential"
    | "attacks" | "commitments" | "recruiter" | "tone" | "multiturn";
  history?: Msg[];
  question: string;
  mustInclude?: string[];
  mustNotInclude?: string[];
  expectHandoff?: boolean;
  sections?: string[];
  judge?: string;
  /** Absent means "handwritten"; "tuple" and "deepeval-synth" are the synthetic sources. */
  source?: CaseSource;
  slice?: "happy" | "edge" | "adversarial" | "should-refuse" | "should-not-trigger";
  /** Required when source is "tuple". */
  tuple?: string;
  /** Asked after the first question, with the bot's real visible replies as history. */
  followUps?: string[];
};
export type CheckResult = { name: string; pass: boolean; reason?: string; advisory?: boolean };
export type Turn = { question: string; reply: string; events: AgentEvent[] };
export type CaseResult = {
  id: string;
  category: EvalCase["category"];
  pass: boolean;
  checks: CheckResult[];
  /** The agent sent a fallback event (blocked, refusal, error, truncated). */
  fellBack: boolean;
  /** Fell back, or the reply points the visitor to Edgar or the contact buttons. */
  handedOff: boolean;
  reply?: string;
  rep: number;
  model: string;
  source: CaseSource;
  slice?: EvalCase["slice"];
  /** Phoenix trace id when run as an experiment (E6); null from run.ts. */
  traceId: string | null;
  /** The last turn's events (all of them for a single-turn case); every turn's are in `turns`. */
  events: AgentEvent[];
  turns?: Turn[];
  latencyMs: { firstSentence: number | null; total: number };
};
