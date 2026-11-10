import { createClient } from "@arizeai/phoenix-client";
import { expect, test } from "vitest";
import { ensureAnnotationConfig, listTraceAnnotations, postTraceAnnotations, postTraceNote } from "./rest";

/** A Phoenix client whose fetch records requests and answers from `reply`. */
function fake(reply: (method: string, path: string) => { status: number; body: unknown }) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const client = createClient({
    options: {
      baseUrl: "http://127.0.0.1:6006",
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const text = await req.text();
        seen.push({ method: req.method, url: url.pathname + url.search, body: text ? JSON.parse(text) : null });
        const r = reply(req.method, url.pathname);
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
      },
    },
  });
  return { client, seen };
}

test("postTraceAnnotations and postTraceNote send the openapi.json bodies", async () => {
  const { client, seen } = fake(() => ({ status: 200, body: { data: [{ id: "x" }] } }));
  await postTraceAnnotations(
    [{ traceId: "t1", name: "edgar_verdict", label: "fail", explanation: "wrong year", annotatorKind: "HUMAN", identifier: "label:2026-11-10" }],
    client,
  );
  await postTraceNote("t1", "says 2019, career.md says 2018", "discover:2026-11-10", client);
  expect(seen).toEqual([
    {
      method: "POST", url: "/v1/trace_annotations?sync=true",
      body: { data: [{ trace_id: "t1", name: "edgar_verdict", annotator_kind: "HUMAN", identifier: "label:2026-11-10", result: { label: "fail", explanation: "wrong year" } }] },
    },
    { method: "POST", url: "/v1/trace_notes", body: { data: { trace_id: "t1", note: "says 2019, career.md says 2018", identifier: "discover:2026-11-10" } } },
  ]);
});

test("listTraceAnnotations follows the cursor and filters by identifier and names", async () => {
  let page = 0;
  const { client, seen } = fake(() =>
    page++ === 0 ? { status: 200, body: { data: [{ id: "a" }], next_cursor: "c2" } } : { status: 200, body: { data: [{ id: "b" }], next_cursor: null } },
  );
  const all = await listTraceAnnotations("career-agent-evals", { identifier: "label:2026-11-10", names: ["edgar_verdict"] }, client);
  expect(all.map((a) => a.id)).toEqual(["a", "b"]);
  expect(seen.map((s) => s.url)).toEqual([
    "/v1/projects/career-agent-evals/trace_annotations?identifier=label%3A2026-11-10&include_annotation_names=edgar_verdict&limit=1000",
    "/v1/projects/career-agent-evals/trace_annotations?identifier=label%3A2026-11-10&include_annotation_names=edgar_verdict&limit=1000&cursor=c2",
  ]);
});

test("ensureAnnotationConfig creates a categorical config only when it is missing", async () => {
  const missing = fake((m) => (m === "GET" ? { status: 404, body: { detail: "not found" } } : { status: 200, body: { data: { id: "cfg1" } } }));
  await ensureAnnotationConfig("edgar_verdict", ["pass", "fail", "defer"], missing.client);
  expect(missing.seen.map((s) => [s.method, s.url, s.body])).toEqual([
    ["GET", "/v1/annotation_configs/edgar_verdict", null],
    ["POST", "/v1/annotation_configs", {
      name: "edgar_verdict", type: "CATEGORICAL", optimization_direction: "NONE",
      values: [{ label: "pass" }, { label: "fail" }, { label: "defer" }],
    }],
  ]);
  const present = fake(() => ({ status: 200, body: { data: { id: "cfg1", name: "edgar_verdict" } } }));
  await ensureAnnotationConfig("edgar_verdict", ["pass", "fail", "defer"], present.client);
  expect(present.seen.map((s) => s.method)).toEqual(["GET"]);
});
