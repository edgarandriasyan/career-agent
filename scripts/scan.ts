import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type ScanHit = { file: string; line: number; term: string };

const SKIP = new Set(["node_modules", ".git", ".wrangler"]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive; whitespace runs in a term match any whitespace, newlines included. */
export function scanText(file: string, text: string, terms: string[]): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const term of terms) {
    const words = term.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const re = new RegExp(words.map(escape).join("\\s+"), "gi");
    for (const m of text.matchAll(re)) {
      hits.push({ file, line: text.slice(0, m.index).split("\n").length, term });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Scan every file, binary or not. Also scan with NUL bytes removed so UTF-16 text matches. */
export function scanBuffer(file: string, buf: Buffer, terms: string[]): ScanHit[] {
  const seen = new Set<string>();
  return [
    ...scanText(file, buf.toString("utf8"), terms),
    ...scanText(file, buf.toString("latin1").replaceAll("\0", ""), terms),
  ].filter((h) => {
    const key = `${h.line}:${h.term}`;
    return !seen.has(key) && seen.add(key);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const bi = args.indexOf("--blocklist");
  const blocklist = bi >= 0 ? args[bi + 1] : undefined;
  const dir = args.filter((_, i) => i !== bi && i !== bi + 1)[0];
  if (!blocklist || !dir) {
    console.error("Usage: npm run scan -- --blocklist <path> <dir>");
    process.exit(1);
  }
  let terms: string[];
  try {
    terms = JSON.parse(readFileSync(blocklist, "utf8")).terms;
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === "string")) throw 0;
  } catch {
    console.error('blocklist is not readable {"terms": string[]} JSON');
    process.exit(1);
  }
  if (!terms.length) {
    console.error("blocklist has no terms");
    process.exit(1);
  }
  let count = 0;
  for (const file of walk(dir)) {
    for (const h of scanBuffer(file, readFileSync(file), terms)) {
      console.error(`${h.file}:${h.line}`);
      count++;
    }
  }
  if (count) {
    console.error(`Blocked: ${count} hit(s).`);
    process.exit(1);
  }
  console.log("Scan clean: no blocklist terms found.");
}
