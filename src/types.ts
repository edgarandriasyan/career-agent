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
