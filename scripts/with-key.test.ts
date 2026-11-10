import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, expect, test } from "vitest";

// Only a temporary fake HOME and a fake value are used, never the real key file.
const SCRIPT = fileURLToPath(new URL("../../private/evals/with-key.sh", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "wk-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function run(content: string | null, mode = 0o600, cmd = ["sh", "-c", 'test "$ANTHROPIC_API_KEY" = fakevalue']) {
  const dir = join(home, ".config", "career-agent");
  rmSync(join(home, ".config"), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (content !== null) {
    const f = join(dir, "anthropic.env");
    writeFileSync(f, content);
    chmodSync(f, mode);
  }
  const r = spawnSync("sh", [SCRIPT, ...cmd], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
  expect(r.stdout + r.stderr).not.toContain("fakevalue");
  return r;
}

test("passes the key to the child only", () => expect(run("ANTHROPIC_API_KEY=fakevalue\n").status).toBe(0));
test("missing file exits 2", () => {
  const r = run(null);
  expect([r.status, r.stderr]).toEqual([2, expect.stringContaining("key file missing")]);
});
test("mode other than 600 exits 2", () => {
  const r = run("ANTHROPIC_API_KEY=fakevalue\n", 0o644);
  expect([r.status, r.stderr]).toEqual([2, expect.stringContaining("mode 600")]);
});
test("unreadable file exits 2 with a message", () => {
  const r = run("ANTHROPIC_API_KEY=fakevalue\n", 0o000);
  expect(r.status).toBe(2);
  expect(r.stderr).not.toBe("");
});
test("empty file exits 2", () => expect(run("").status).toBe(2));
test("file without the key exits 2", () => expect(run("OTHER=1\n").status).toBe(2));
test("empty key value exits 2", () => expect(run("ANTHROPIC_API_KEY=\n").status).toBe(2));
test("a line that is not plain NAME=value exits 2 and runs nothing", () => {
  const r = run("ANTHROPIC_API_KEY=fakevalue touch " + join(home, "ran") + "\n");
  expect(r.status).toBe(2);
  expect(spawnSync("test", ["-e", join(home, "ran")]).status).not.toBe(0);
});
test("no command exits 2", () => expect(run("ANTHROPIC_API_KEY=fakevalue\n", 0o600, []).status).toBe(2));
