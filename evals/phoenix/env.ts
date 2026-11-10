/*
 * Phoenix client environment for eval processes (phoenix-review.md 1.6 and 9.4). The local server
 * runs only from private/phoenix/serve.sh on 127.0.0.1:6006. usePhoenixEnv() sets and asserts the
 * environment; every Phoenix CLI calls it before its first client, tracer or Anthropic client is
 * created. @arizeai/* and the Anthropic SDK read these variables when used, not at import:
 * phoenix-config reads PHOENIX_DISCOVER_CONFIG per lookup (envFile.ts), and the SDK reads
 * ANTHROPIC_OPEN_TELEMETRY_* when a client is constructed (internal/tracing.mjs).
 * This file imports nothing from @arizeai/*.
 */

export const PHOENIX_URL = "http://127.0.0.1:6006";

export const PHOENIX_ENV: Record<string, string> = {
  PHOENIX_ENDPOINT: PHOENIX_URL,
  PHOENIX_COLLECTOR_ENDPOINT: PHOENIX_URL,
  /** No .env.phoenix discovery walking up from the cwd. */
  PHOENIX_DISCOVER_CONFIG: "false",
  /** The SDK's own LLM span keeps the model's text (incl. blocked sentences) in the local Phoenix only. */
  ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE: "content",
};

/** Must be absent: PHOENIX_HOST is the server's bind address (and a legacy client URL), the rest redirect or authenticate exports. */
const UNSET = ["PHOENIX_HOST", "PHOENIX_API_KEY"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const isLoopback = (url: string | undefined) => {
  try {
    return !!url && LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
};

export function assertPhoenixEnv(env: NodeJS.ProcessEnv): void {
  for (const k of ["PHOENIX_ENDPOINT", "PHOENIX_COLLECTOR_ENDPOINT"])
    if (!isLoopback(env[k])) throw new Error(`Phoenix env: ${k} must be a loopback URL`);
  if (env.PHOENIX_DISCOVER_CONFIG !== "false") throw new Error("Phoenix env: PHOENIX_DISCOVER_CONFIG must be false");
  for (const k of Object.keys(env))
    if ((UNSET.includes(k) || k.startsWith("OTEL_EXPORTER_")) && env[k] !== undefined) throw new Error(`Phoenix env: ${k} must be unset`);
}

/** Sets this process's Phoenix environment and asserts it. */
export function usePhoenixEnv(): void {
  for (const k of Object.keys(process.env)) if (UNSET.includes(k) || k.startsWith("OTEL_EXPORTER_")) delete process.env[k];
  Object.assign(process.env, PHOENIX_ENV);
  assertPhoenixEnv(process.env);
}

/** True when the server answers GET /v1/projects. Never throws. */
export async function phoenixUp(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/v1/projects`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
