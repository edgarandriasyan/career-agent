export type Msg = { role: "user" | "assistant"; text: string };
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type FallbackReason = "blocked" | "refusal" | "api_error" | "truncated";
export type AgentEvent =
  | { type: "sentence"; text: string; sources: string[] }
  | { type: "fallback"; reason: FallbackReason; detail?: string }
  | { type: "done"; usage: Usage; costUsd: number; model: string };
export type EvalCase = {
  id: string;
  category: "facts" | "conflicts" | "fit" | "not_in_corpus" | "confidential"
    | "attacks" | "commitments" | "recruiter" | "tone";
  history?: Msg[];
  question: string;
  mustInclude?: string[];
  mustNotInclude?: string[];
  expectHandoff?: boolean;
  sections?: string[];
  judge?: string;
};
export type CheckResult = { name: string; pass: boolean; reason?: string };
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
};
