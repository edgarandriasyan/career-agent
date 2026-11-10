import { mulberry32 } from "./splits";

/*
 * Statistics for gates and judge validation. No dependencies.
 * Exact binomial (Clopper-Pearson) bounds come from bisection on the binomial CDF.
 */

const lnFact = (n: number) => {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
};

/** P(X <= k) for X ~ Binomial(n, p). */
function binomCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  const lnN = lnFact(n);
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(lnN - lnFact(i) - lnFact(n - i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(s, 1);
}

/** The p in [0, 1] where the decreasing function f(p) crosses `target`. */
function bisect(f: (p: number) => number, target: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Two-sided exact interval for k successes in n. */
export function clopperPearson(k: number, n: number, conf = 0.95): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const a = (1 - conf) / 2;
  // lo: P(X >= k | p) = a, i.e. 1 - P(X <= k-1) = a; P(X <= k-1) decreases in p.
  const lo = k === 0 ? 0 : bisect((p) => binomCdf(k - 1, n, p), 1 - a);
  const hi = k === n ? 1 : bisect((p) => binomCdf(k, n, p), a);
  return { lo, hi };
}

/** One-sided exact upper bound on the rate of k events in n (e.g. a failure rate). */
export function upperBound(k: number, n: number, conf = 0.95): number {
  if (n === 0 || k >= n) return 1;
  return bisect((p) => binomCdf(k, n, p), 1 - conf);
}

/** Corrected true pass rate from an observed judge pass rate, clipped to [0, 1]. */
export function roganGladen(pObs: number, tpr: number, tnr: number): number {
  if (Math.abs(tpr + tnr - 1) < 1e-6) throw new Error("judge no better than chance");
  return Math.min(1, Math.max(0, (pObs + tnr - 1) / (tpr + tnr - 1)));
}

/** Judge agreement with human labels; Pass (true) is the positive class. */
export function tprTnr(human: boolean[], judge: boolean[]) {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  human.forEach((h, i) => {
    if (h) judge[i] ? tp++ : fn++;
    else judge[i] ? fp++ : tn++;
  });
  return { tpr: tp + fn ? tp / (tp + fn) : 0, tnr: tn + fp ? tn / (tn + fp) : 0, tp, fn, tn, fp };
}

const quantile = (sorted: number[], q: number) => {
  const x = q * (sorted.length - 1);
  const i = Math.floor(x);
  return i + 1 < sorted.length ? sorted[i] + (x - i) * (sorted[i + 1] - sorted[i]) : sorted[i];
};

/**
 * Bootstrap interval for the Rogan-Gladen corrected rate: resample the labeled (human, judge) pairs,
 * recompute TPR, TNR and the corrected rate, skip draws where the judge is no better than chance.
 */
export function bootstrapCI(
  human: boolean[],
  judge: boolean[],
  pObs: number,
  o: { seed: number; iters?: number; conf?: number },
): { lo: number; hi: number } {
  const rand = mulberry32(o.seed);
  const n = human.length;
  const est: number[] = [];
  for (let b = 0; b < (o.iters ?? 2000); b++) {
    const h: boolean[] = [];
    const j: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rand() * n);
      h.push(human[k]);
      j.push(judge[k]);
    }
    const { tpr, tnr } = tprTnr(h, j);
    if (Math.abs(tpr + tnr - 1) < 1e-6) continue;
    est.push(roganGladen(pObs, tpr, tnr));
  }
  if (!est.length) throw new Error("judge no better than chance");
  est.sort((a, b) => a - b);
  const a = (1 - (o.conf ?? 0.95)) / 2;
  return { lo: quantile(est, a), hi: quantile(est, 1 - a) };
}
