import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { assertPhoenixEnv, PHOENIX_ENV, phoenixUp } from "./env";

const good = (): NodeJS.ProcessEnv => ({ ...PHOENIX_ENV });

test("assertPhoenixEnv accepts the plan's environment", () => {
  expect(() => assertPhoenixEnv(good())).not.toThrow();
  expect(() => assertPhoenixEnv({ ...good(), PHOENIX_ENDPOINT: "http://localhost:6006", PHOENIX_COLLECTOR_ENDPOINT: "http://[::1]:6006" })).not.toThrow();
});

test("assertPhoenixEnv throws on a non-loopback endpoint, PHOENIX_HOST, PHOENIX_API_KEY or OTEL_EXPORTER_* set", () => {
  for (const k of ["PHOENIX_ENDPOINT", "PHOENIX_COLLECTOR_ENDPOINT"]) {
    expect(() => assertPhoenixEnv({ ...good(), [k]: "https://app.phoenix.example.com" }), k).toThrow(k);
    expect(() => assertPhoenixEnv({ ...good(), [k]: "http://10.0.0.5:6006" }), k).toThrow(k);
    expect(() => assertPhoenixEnv({ ...good(), [k]: "http://127.0.0.1.example.com:6006" }), k).toThrow(k);
    expect(() => assertPhoenixEnv({ ...good(), [k]: undefined }), k).toThrow(k);
  }
  for (const k of ["PHOENIX_HOST", "PHOENIX_API_KEY", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"]) {
    expect(() => assertPhoenixEnv({ ...good(), [k]: "http://127.0.0.1:6006" }), k).toThrow(k);
    expect(() => assertPhoenixEnv({ ...good(), [k]: "" }), k).toThrow(k);
  }
});

test("assertPhoenixEnv throws unless PHOENIX_DISCOVER_CONFIG is false", () => {
  const { PHOENIX_DISCOVER_CONFIG: _, ...rest } = good();
  expect(() => assertPhoenixEnv(rest)).toThrow("PHOENIX_DISCOVER_CONFIG");
  expect(() => assertPhoenixEnv({ ...good(), PHOENIX_DISCOVER_CONFIG: "true" })).toThrow("PHOENIX_DISCOVER_CONFIG");
});

test("phoenixUp is true only when GET /v1/projects answers ok", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.statusCode = req.url === "/v1/projects" ? 200 : 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    expect(await phoenixUp(`http://127.0.0.1:${port}`)).toBe(true);
    expect(seen).toEqual(["GET /v1/projects"]);
  } finally {
    await new Promise((r) => server.close(r));
  }
  expect(await phoenixUp(`http://127.0.0.1:${port}`)).toBe(false); // closed: refused, not thrown
});
