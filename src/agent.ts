import Anthropic from "@anthropic-ai/sdk";
import { checkSentence, corpusNumbers } from "./checks";
import { sectionForChar } from "./citations";
import { SYSTEM_PROMPT } from "./prompt";
import { SentenceSegmenter } from "./sentences";
import { costUsd } from "./spend";
import type { AgentEvent, Msg, Usage } from "./types";

/** `system` defaults to SYSTEM_PROMPT. Eval-only (ablation runs): never set it from request data. */
export type AnswerInput = { career: string; history: Msg[]; question: string; model: string; blocklist: string[]; system?: string };

/**
 * The first user message is always the cached career.md document plus the first question, so
 * every turn of a conversation shares the same prefix. Later turns follow as plain text; `history`
 * holds only text the visitor saw. A question whose answer showed no text (a refusal, or a
 * fallback before the first sentence) is dropped with its answer: the API rejects an empty
 * assistant turn, and a refused turn should not be continued.
 */
export function buildMessages(career: string, history: Msg[], question: string): Anthropic.MessageParam[] {
  const kept = history.filter((t, i) => {
    const answerOf = t.role === "user" ? history[i + 1] : t;
    return !(answerOf?.role === "assistant" && !answerOf.text.trim());
  });
  const turns: Msg[] = [...kept, { role: "user", text: question }];
  return turns.map((t, i) =>
    i === 0
      ? {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: career },
              title: "Edgar Andriasyan career",
              citations: { enabled: true },
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: t.text },
          ],
        }
      : { role: t.role, content: t.text },
  );
}

const MAX_TOKENS = 1024;

/** The one request shape used by answer() and the smoke script. No tools, sampling params or thinking. */
export function requestParams(i: AnswerInput): Anthropic.MessageStreamParams {
  return {
    model: i.model,
    max_tokens: MAX_TOKENS,
    system: i.system ?? SYSTEM_PROMPT,
    output_config: { effort: "low" },
    messages: buildMessages(i.career, i.history, i.question),
  };
}

/**
 * Streams a reply as checked sentences. A sentence is yielded only after it passes checkSentence.
 * The first failure aborts the stream and ends with a "blocked" fallback; the failed text is never
 * yielded. Always ends with a "done" event carrying usage and cost. `onText` (evals only; production
 * never passes it) receives every raw text delta, including text of a sentence that is later blocked.
 */
export async function* answer(
  i: AnswerInput,
  d: { client: Anthropic; onText?: (delta: string) => void },
): AsyncGenerator<AgentEvent> {
  const ctx = { blocklist: i.blocklist, numbers: corpusNumbers(i.career) };
  const seg = new SentenceSegmenter();
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Sources per content block, and the blocks whose text is still in the segmenter buffer.
  const blockSources = new Map<number, Set<string>>();
  let touched = new Set<number>();
  let stopReason: string | null = null;
  let sawDelta = false;
  let shown = 0;
  let fallback: Extract<AgentEvent, { type: "fallback" }> | undefined;

  const sourcesOf = (blocks: Set<number>) => [...new Set([...blocks].flatMap((b) => [...(blockSources.get(b) ?? [])]))];
  /** Checks a sentence; returns the event to yield, or sets the fallback and returns undefined. */
  const vet = (s: string): AgentEvent | undefined => {
    const r = checkSentence(s, ctx);
    if (r.ok) return { type: "sentence", text: s, sources: sourcesOf(touched) };
    // The detail never carries the failed text: blocklist details name only the term's position.
    fallback = { type: "fallback", reason: "blocked", detail: r.reason === "blocklist" ? r.detail : "number" };
  };

  const stream = d.client.messages.stream(requestParams(i));
  try {
    read: for await (const ev of stream) {
      if (ev.type === "message_start") {
        const u = ev.message.usage;
        usage.input = u.input_tokens;
        usage.output = u.output_tokens;
        usage.cacheRead = u.cache_read_input_tokens ?? 0;
        usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      } else if (ev.type === "message_delta") {
        sawDelta = true;
        stopReason = ev.delta.stop_reason;
        usage.output = ev.usage.output_tokens;
        usage.input = ev.usage.input_tokens ?? usage.input;
        usage.cacheRead = ev.usage.cache_read_input_tokens ?? usage.cacheRead;
        usage.cacheWrite = ev.usage.cache_creation_input_tokens ?? usage.cacheWrite;
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "citations_delta" && ev.delta.citation.type === "char_location") {
          const set = blockSources.get(ev.index) ?? new Set();
          set.add(sectionForChar(i.career, ev.delta.citation.start_char_index));
          blockSources.set(ev.index, set);
        } else if (ev.delta.type === "text_delta") {
          d.onText?.(ev.delta.text);
          if (ev.delta.text.trim()) touched.add(ev.index);
          for (const s of seg.push(ev.delta.text)) {
            const out = vet(s);
            if (!out) {
              stream.abort();
              break read;
            }
            yield out;
            shown++;
            touched = new Set([ev.index]); // the next sentence starts in this block
          }
          if (!seg.pending) touched.clear();
        }
      }
    }
  } catch (e) {
    const detail = e instanceof Anthropic.APIError ? `status ${e.status ?? "none"}` : e instanceof Error ? e.name : "error";
    fallback = { type: "fallback", reason: "api_error", detail };
  }

  if (!fallback) {
    if (stopReason === "end_turn") {
      for (const s of seg.flush()) {
        const out = vet(s);
        if (!out) break;
        yield out;
        shown++;
      }
      if (!shown && !fallback) fallback = { type: "fallback", reason: "truncated", detail: "empty" };
    } else if (stopReason === "refusal") {
      fallback = { type: "fallback", reason: "refusal" };
    } else {
      // max_tokens, a context-window stop, or a stream that ended without a stop reason:
      // the unfinished fragment is dropped.
      fallback = { type: "fallback", reason: "truncated", detail: stopReason ?? "no stop reason" };
    }
  }
  if (fallback) yield fallback;
  // Cut before message_delta (blocked or error): the final output count never arrived, so bill
  // the upper bound. Spend tracking errs high, never low.
  if (!sawDelta) usage.output = MAX_TOKENS;
  yield { type: "done", usage, costUsd: costUsd(i.model, usage), model: i.model };
}
