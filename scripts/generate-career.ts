import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEADING = /^(#{1,6})\s/;
const TAG = /^<!--\s*visibility:\s*(\S+)\s*-->\s*$/;

/** Keep only sections tagged public; drop tag lines, untagged text and private subtrees. */
export function generateCareer(master: string): string {
  const lines = master.split("\n");
  const out: string[] = [];
  // Levels of open headings, with whether each is public.
  const stack: { level: number; pub: boolean }[] = [];
  let inFence = false;
  let current: { pub: boolean } | null = null; // null before the first heading

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && line.match(HEADING);
    if (!m) {
      if (current?.pub) out.push(line);
      continue;
    }

    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parentPublic = stack.length === 0 || stack[stack.length - 1].pub;

    const tag = lines[i + 1]?.match(TAG);
    if (tag && tag[1] !== "public" && tag[1] !== "private") {
      throw new Error(`Unknown visibility "${tag[1]}" on line ${i + 2}`);
    }
    const pub = tag?.[1] === "public";
    if (pub && !parentPublic) {
      throw new Error(`Public section under a non-public parent at line ${i + 1}`);
    }

    stack.push({ level, pub });
    current = { pub };
    if (pub) out.push(line);
    if (tag) i++; // strip the tag line
  }

  const text = out.join("\n");
  return text.trim() === "" ? "" : text.replace(/\n*$/, "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = resolve(root, "../private/career-master.md");
  if (!existsSync(src)) {
    console.error(`Missing ${src}. Create private/career-master.md first.`);
    process.exit(1);
  }
  try {
    const dest = resolve(root, "corpus/career.md");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, generateCareer(readFileSync(src, "utf8")));
    console.log(`Wrote ${dest}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
