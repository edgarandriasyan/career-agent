import { SYSTEM_PROMPT } from "../src/prompt";
import type { CaseSource } from "../src/types";

/** Removes `<section>...</section>` and the blank line after it. Throws when the prompt has no such section. */
export function ablate(prompt: string, section: string): string {
  const open = `<${section}>`;
  const close = `</${section}>`;
  const start = prompt.indexOf(open);
  const end = prompt.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`Unknown prompt section: ${section}`);
  return prompt.slice(0, start) + prompt.slice(end + close.length).replace(/^\n\n/, "");
}

/** What `--ablate <section>` changes: the reduced system prompt and the run source. */
export const ablation = (section: string): { system: string; source: CaseSource } => ({
  system: ablate(SYSTEM_PROMPT, section),
  source: "ablation",
});
