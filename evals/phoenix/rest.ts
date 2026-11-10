import { createClient, HttpError, type PhoenixClient } from "@arizeai/phoenix-client";
import { PHOENIX_URL } from "./env";

/*
 * Phoenix REST calls the client library does not wrap, for labels and notes (phoenix-review.md 5).
 * Paths and bodies follow vendor/phoenix/schemas/openapi.json, and the typed client checks them at
 * compile time: POST /v1/trace_annotations, POST /v1/trace_notes,
 * GET /v1/projects/{project_identifier}/trace_annotations, GET /v1/annotation_configs/{config_identifier},
 * POST /v1/annotation_configs. Errors carry the URL and status only (HttpError), never a body.
 */

let shared: PhoenixClient | undefined;
const local = () => (shared ??= createClient({ options: { baseUrl: PHOENIX_URL } }));

export type TraceAnnotationInput = {
  traceId: string;
  name: string;
  label: string;
  explanation?: string;
  annotatorKind: "HUMAN" | "LLM" | "CODE";
  /** A labeling session, e.g. "label:2026-11-10"; the same (trace, name, identifier) is updated, not duplicated. */
  identifier: string;
};

export async function postTraceAnnotations(a: TraceAnnotationInput[], client = local()): Promise<void> {
  await client.POST("/v1/trace_annotations", {
    params: { query: { sync: true } },
    body: {
      data: a.map((x) => ({
        trace_id: x.traceId,
        name: x.name,
        annotator_kind: x.annotatorKind,
        identifier: x.identifier,
        result: { label: x.label, ...(x.explanation !== undefined ? { explanation: x.explanation } : {}) },
      })),
    },
  });
}

/** A free-text note on a trace; the same identifier overwrites that note. */
export async function postTraceNote(traceId: string, text: string, identifier: string, client = local()): Promise<void> {
  await client.POST("/v1/trace_notes", { body: { data: { trace_id: traceId, note: text, identifier } } });
}

export async function listTraceAnnotations(project: string, o: { identifier?: string; names?: string[] }, client = local()) {
  const out = [];
  let cursor: string | null | undefined;
  do {
    const res = await client.GET("/v1/projects/{project_identifier}/trace_annotations", {
      params: {
        path: { project_identifier: project },
        query: {
          ...(o.identifier ? { identifier: [o.identifier] } : {}),
          ...(o.names ? { include_annotation_names: o.names } : {}),
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        },
      },
    });
    out.push(...(res.data?.data ?? []));
    cursor = res.data?.next_cursor;
  } while (cursor);
  return out;
}

/** Creates a categorical annotation config (e.g. edgar_verdict: pass, fail, defer) unless one with this name exists. */
export async function ensureAnnotationConfig(name: string, labels: string[], client = local()): Promise<void> {
  try {
    await client.GET("/v1/annotation_configs/{config_identifier}", { params: { path: { config_identifier: name } } });
    return;
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 404)) throw e;
  }
  await client.POST("/v1/annotation_configs", {
    body: { name, type: "CATEGORICAL", optimization_direction: "NONE", values: labels.map((label) => ({ label })) },
  });
}
