/** Seeded PRNG (mulberry32): returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Splits items into `fractions.length` parts, stratified by `key`: each group is shuffled with the
 * seeded PRNG and cut at rounded cumulative fractions, so every group's share in every part is
 * within one item of its fraction. Same seed, same split.
 */
export function stratifiedSplit<T>(items: T[], key: (t: T) => string, fractions: number[], seed: number): T[][] {
  const rand = mulberry32(seed);
  const groups = new Map<string, T[]>();
  for (const t of items) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
  const parts: T[][] = fractions.map(() => []);
  for (const k of [...groups.keys()].sort()) {
    const g = [...groups.get(k)!];
    for (let i = g.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [g[i], g[j]] = [g[j], g[i]];
    }
    let cum = 0;
    let start = 0;
    fractions.forEach((f, j) => {
      cum += f;
      const end = j === fractions.length - 1 ? g.length : Math.round(cum * g.length);
      parts[j].push(...g.slice(start, end));
      start = end;
    });
  }
  return parts;
}
