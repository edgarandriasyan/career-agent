import type Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "vitest";
import { answer, buildMessages } from "./agent";
import { sectionForChar } from "./citations";
import { SYSTEM_PROMPT } from "./prompt";
import type { AgentEvent } from "./types";

// Made-up corpus: every number used in the fake replies appears here.
const CAREER = "# Edgar\n\nIntro.\n\n## Alpha role\n\nEdgar grew Alpha 8% in 2024.\n\n### Alpha: detail\n\nDetail text.\n\n## Beta role\n\nBeta had 12 people.\n";
const MODEL = "claude-haiku-5-5";

const start = { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } } };
const text = (t: string, index = 0) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text: t } });
const cite = (at: number, index = 0) => ({
  type: "content_block_delta",
  index,
  delta: { type: "citations_delta", citation: { type: "char_location", start_char_index: at, end_char_index: at + 5, cited_text: "x", document_index: 0, document_title: "t", file_id: null } },
});
const stop = (reason: string, output = 20) => ({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: output } });

/** A fake client whose stream yields `events` (a function throws when reached) and records what happened. */
function fake(events: unknown[]) {
  const log = { params: undefined as any, pulled: 0, ended: false, aborted: false };
  const client = {
    messages: {
      stream(params: unknown) {
        log.params = params;
        return {
          abort() {
            log.aborted = true;
          },
          async *[Symbol.asyncIterator]() {
            for (const e of events) {
              log.pulled++;
              if (typeof e === "function") e();
              yield e;
            }
            log.ended = true;
          },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, log };
}

const run = async (events: unknown[], blocklist: string[] = []) => {
  const { client, log } = fake(events);
  const out: AgentEvent[] = [];
  for await (const e of answer({ career: CAREER, history: [], question: "q", model: MODEL, blocklist }, { client })) out.push(e);
  return { out, log };
};
const sentences = (out: AgentEvent[]) => out.flatMap((e) => (e.type === "sentence" ? [e.text] : []));

test("emits passing sentences with sources", async () => {
  const alpha = CAREER.indexOf("Edgar grew");
  const beta = CAREER.indexOf("Beta had");
  const { out } = await run([start, cite(alpha, 0), text("Edgar grew Alpha 8% in 2024. ", 0), text("Beta had 12 people.", 1), cite(beta, 1), stop("end_turn")]);
  expect(out.filter((e) => e.type === "sentence")).toEqual([
    { type: "sentence", text: "Edgar grew Alpha 8% in 2024.", sources: ["Alpha role"] },
    { type: "sentence", text: "Beta had 12 people.", sources: ["Beta role"] },
  ]);
  const done = out.at(-1);
  expect(done?.type).toBe("done");
  if (done?.type === "done") {
    expect(done.usage).toEqual({ input: 10, output: 20, cacheRead: 0, cacheWrite: 100 });
    expect(done.model).toBe(MODEL);
    expect(done.costUsd).toBeGreaterThan(0);
  }
});

test("first sentence emits before stream ends", async () => {
  const { client, log } = fake([start, text("First one. Second"), text(" one."), stop("end_turn")]);
  const gen = answer({ career: CAREER, history: [], question: "q", model: MODEL, blocklist: [] }, { client });
  const first = await gen.next();
  expect(first.value).toMatchObject({ type: "sentence", text: "First one." });
  expect(log.ended).toBe(false);
  expect(log.pulled).toBe(2);
});

test("blocked sentence stops, no failed text", async () => {
  const { out, log } = await run([start, text("Fine sentence. The secretterm is here. "), text("Later sentence."), stop("end_turn")], ["secretterm"]);
  expect(sentences(out)).toEqual(["Fine sentence."]);
  expect(out.filter((e) => e.type !== "sentence").map((e) => e.type)).toEqual(["fallback", "done"]);
  expect(out.find((e) => e.type === "fallback")).toMatchObject({ reason: "blocked" });
  const json = JSON.stringify(out);
  expect(json).not.toContain("secretterm");
  expect(json).not.toContain("is here");
  expect(json).not.toContain("Later");
  expect(log.aborted).toBe(true);
  expect(log.pulled).toBe(2);
});

test("a number not in the corpus blocks the sentence", async () => {
  const { out } = await run([start, text("Edgar grew Alpha 8%. He earned $999k. "), stop("end_turn")]);
  expect(sentences(out)).toEqual(["Edgar grew Alpha 8%."]);
  expect(out.find((e) => e.type === "fallback")).toMatchObject({ reason: "blocked" });
  expect(JSON.stringify(out)).not.toContain("999");
});

test("stream error after a sentence", async () => {
  const boom = () => {
    throw new Error("network secretterm");
  };
  const { out } = await run([start, text("One sentence. Two"), boom]);
  expect(out.map((e) => e.type)).toEqual(["sentence", "fallback", "done"]);
  expect(out[1]).toMatchObject({ reason: "api_error" });
  expect(JSON.stringify(out)).not.toContain("secretterm");
  expect(JSON.stringify(out)).not.toContain("Two");
});

test("refusal stop reason", async () => {
  const { out } = await run([start, text("Partial"), stop("refusal")]);
  expect(out.map((e) => e.type)).toEqual(["fallback", "done"]);
  expect(out[0]).toMatchObject({ reason: "refusal" });
  expect(JSON.stringify(out)).not.toContain("Partial");
});

test("max_tokens drops the fragment", async () => {
  const { out } = await run([start, text("One done. Two cut"), stop("max_tokens")]);
  expect(sentences(out)).toEqual(["One done."]);
  expect(out.find((e) => e.type === "fallback")).toMatchObject({ reason: "truncated" });
  expect(JSON.stringify(out)).not.toContain("Two cut");
  expect(out.at(-1)?.type).toBe("done");
});

test("buildMessages keeps a stable prefix", () => {
  const first = buildMessages(CAREER, [], "First question?");
  const later = buildMessages(
    CAREER,
    [
      { role: "user", text: "First question?" },
      { role: "assistant", text: "First answer." },
    ],
    "Second question?",
  );
  expect(later[0]).toEqual(first[0]);
  expect(later.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(later.at(-1)).toEqual({ role: "user", content: "Second question?" });
  expect(later[1]).toEqual({ role: "assistant", content: "First answer." });
});

test("document has citations and cache_control", () => {
  const [m] = buildMessages(CAREER, [], "q");
  const content = m.content as Anthropic.ContentBlockParam[];
  expect(content[0]).toEqual({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: CAREER },
    title: "Edgar Andriasyan career",
    citations: { enabled: true },
    cache_control: { type: "ephemeral" },
  });
  expect(content[1]).toEqual({ type: "text", text: "q" });
});

test("no tools, no sampling params", async () => {
  const { log } = await run([start, text("Fine."), stop("end_turn")]);
  const p = log.params;
  expect(p.model).toBe(MODEL);
  expect(p.max_tokens).toBe(1024);
  expect(p.system).toBe(SYSTEM_PROMPT);
  expect(p.output_config).toEqual({ effort: "low" });
  for (const k of ["tools", "tool_choice", "temperature", "top_p", "top_k", "thinking", "fallbacks", "betas", "stop_sequences"])
    expect(p).not.toHaveProperty(k);
  expect(p.messages.at(-1).role).toBe("user"); // no assistant prefill
});

test("sectionForChar maps an index to the nearest heading above it", () => {
  expect(sectionForChar(CAREER, CAREER.indexOf("Edgar grew"))).toBe("Alpha role");
  expect(sectionForChar(CAREER, CAREER.indexOf("Detail text"))).toBe("Alpha: detail");
  expect(sectionForChar(CAREER, CAREER.indexOf("Intro"))).toBe("Edgar");
  expect(sectionForChar("no headings", 3)).toBe("");
});

test("SYSTEM_PROMPT carries no placeholder or blocklist-like content", () => {
  expect(SYSTEM_PROMPT).not.toMatch(/[—–]|\p{Extended_Pictographic}/u);
  expect(SYSTEM_PROMPT).not.toMatch(/\d{5,}/); // no phone numbers or figures
});

test("a second sentence completed in the same delta keeps its block's sources", async () => {
  const at = CAREER.indexOf("Edgar grew");
  const { out } = await run([start, cite(at), text("Edgar grew Alpha. Alpha grew 8%. More"), text(" text."), stop("end_turn")]);
  expect(out.filter((e) => e.type === "sentence").map((e) => (e.type === "sentence" ? e.sources : []))).toEqual([
    ["Alpha role"],
    ["Alpha role"],
    ["Alpha role"],
  ]);
});

test("done usage counts output up to max_tokens when the stream is cut before message_delta", async () => {
  const blocked = await run([start, text("The secretterm is here. ")], ["secretterm"]);
  const errored = await run([start, text("One. "), () => { throw new Error("x"); }]);
  for (const { out } of [blocked, errored]) {
    const done = out.at(-1);
    expect(done?.type === "done" && done.usage.output).toBe(1024);
  }
});

test("an end_turn with no text falls back instead of showing nothing", async () => {
  const { out } = await run([start, text("   "), stop("end_turn")]);
  expect(out.map((e) => e.type)).toEqual(["fallback", "done"]);
  expect(out[0]).toMatchObject({ reason: "truncated", detail: "empty" });
});

test("history keeps only what the visitor saw: a partial turn is replayed verbatim", async () => {
  // A turn blocked after its first sentence: the visitor saw only that sentence.
  const { out } = await run([start, text("Fine sentence. The secretterm is here. "), stop("end_turn")], ["secretterm"]);
  const seen = sentences(out).join(" ");
  const msgs = buildMessages(CAREER, [{ role: "user", text: "First?" }, { role: "assistant", text: seen }], "Next?");
  expect(msgs[1]).toEqual({ role: "assistant", content: "Fine sentence." });
  expect(JSON.stringify(msgs)).not.toContain("secretterm");
});

test("a question whose answer showed no text is dropped from history", () => {
  const msgs = buildMessages(
    CAREER,
    [
      { role: "user", text: "Refused?" },
      { role: "assistant", text: "  " },
      { role: "user", text: "Second?" },
      { role: "assistant", text: "Answer." },
    ],
    "Third?",
  );
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(JSON.stringify(msgs)).not.toContain("Refused?");
  const first = msgs[0].content as Anthropic.ContentBlockParam[];
  expect(first[0]).toMatchObject({ type: "document", cache_control: { type: "ephemeral" } });
  expect(first[1]).toEqual({ type: "text", text: "Second?" });
});
