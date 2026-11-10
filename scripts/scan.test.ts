import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { scanBuffer, scanText } from "./scan";

test("is case-insensitive", () =>
  expect(scanText("a.md", "x SecretTerm y", ["secretterm"])).toEqual([{ file: "a.md", line: 1, term: "secretterm" }]));
test("matches multi-word terms across any whitespace, reports start line", () =>
  expect(scanText("a.md", "ok\nsecret\n  \n term", ["secret term"])).toEqual([{ file: "a.md", line: 2, term: "secret term" }]));
test("reports the line of each hit", () =>
  expect(scanText("a.md", "a\nb\nsecretterm\nsecretterm", ["secretterm"]).map((h) => h.line)).toEqual([3, 4]));
test("returns [] when clean", () => expect(scanText("a.md", "nothing here", ["secretterm"])).toEqual([]));

test("finds a term in a buffer containing NUL bytes", () =>
  expect(scanBuffer("a.bin", Buffer.from("\0\0xx secretterm \0yy", "latin1"), ["secretterm"]).map((h) => h.line)).toEqual([1]));
test("finds a term in UTF-16 text", () =>
  expect(scanBuffer("a.txt", Buffer.from("a\nsecretterm", "utf16le"), ["secretterm"]).map((h) => h.line)).toEqual([2]));

const run = (args: string[]) =>
  spawnSync("npx", ["tsx", "scripts/scan.ts", ...args], { encoding: "utf8" });

test("CLI flags a binary file with a NUL byte", () => {
  const d = mkdtempSync(join(tmpdir(), "scan-"));
  writeFileSync(join(d, "b.json"), '{"terms":["secretterm"]}');
  mkdirSync(join(d, "t"));
  writeFileSync(join(d, "t", "x.bin"), Buffer.from("\0secretterm\0"));
  const r = run(["--blocklist", join(d, "b.json"), join(d, "t")]);
  expect(r.status).toBe(1);
  expect(r.stderr).not.toContain("secretterm");
});
test("malformed blocklist exits 1 without leaking its content", () => {
  const d = mkdtempSync(join(tmpdir(), "scan-"));
  writeFileSync(join(d, "b.json"), '{"terms": ["secretterm" oops');
  const r = run(["--blocklist", join(d, "b.json"), d]);
  expect(r.status).toBe(1);
  expect(r.stderr).not.toContain("secretterm");
  expect(r.stderr).toContain("blocklist");
});
test("blocklist without a terms array exits 1", () => {
  const d = mkdtempSync(join(tmpdir(), "scan-"));
  writeFileSync(join(d, "b.json"), '{"terms":"secretterm"}');
  const r = run(["--blocklist", join(d, "b.json"), d]);
  expect(r.status).toBe(1);
  expect(r.stderr).not.toContain("secretterm");
});
test("empty blocklist exits 1 with a fixed message", () => {
  const d = mkdtempSync(join(tmpdir(), "scan-"));
  writeFileSync(join(d, "b.json"), '{"terms":[]}');
  const r = run(["--blocklist", join(d, "b.json"), d]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("blocklist has no terms");
});
