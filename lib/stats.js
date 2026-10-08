// ─────────────────────────────────────────────────────────────────
//  Small, dependency-free statistics used by the scoring engine.
//
//  Everything here is a pure function so it can be unit-tested
//  against known reference values (see test/stats.test.js).
// ─────────────────────────────────────────────────────────────────

// log Γ(x) — Lanczos approximation (g=7, n=9), accurate to ~1e-15.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued fraction for the incomplete beta (Numerical Recipes betacf).
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// Regularised incomplete beta I_x(a, b)
function incBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? bt * betacf(a, b, x) / a
    : 1 - bt * betacf(b, a, 1 - x) / b;
}

// Monotone CDF inversion by bisection — slow-ish but bulletproof and
// these are called a handful of times per request.
function invert(cdf, p, lo, hi) {
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid; else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

const betaQuantile = (p, a, b) => invert(x => incBeta(x, a, b), p, 0, 1);

// Student t CDF and quantile
function tCdf(t, df) {
  const x = df / (df + t * t);
  const tail = 0.5 * incBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}
function tQuantile(p, df) {
  if (p === 0.5) return 0;
  return invert(t => tCdf(t, df), p, -1e3, 1e3);
}

// Standard normal quantile via t with huge df is imprecise; use Acklam.
function normQuantile(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > 1 - pl) return -normQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

// ─────────────────────────────────────────────────────────────────
//  Jeffreys interval for a (possibly weighted) proportion.
//  Weighted successes are rescaled to Kish's effective sample size
//  so that ten tiny studies cannot masquerade as ten large ones.
// ─────────────────────────────────────────────────────────────────
function jeffreysInterval(successW, totalW, nEff, level = 0.95) {
  if (!(totalW > 0) || !(nEff > 0)) return { p: null, lo: 0, hi: 1 };
  const p = successW / totalW;
  const a = 0.5 + p * nEff;
  const b = 0.5 + (1 - p) * nEff;
  const alpha = (1 - level) / 2;
  return { p, lo: betaQuantile(alpha, a, b), hi: betaQuantile(1 - alpha, a, b) };
}

function kishNeff(weights) {
  const s = weights.reduce((x, w) => x + w, 0);
  const s2 = weights.reduce((x, w) => x + w * w, 0);
  return s2 > 0 ? (s * s) / s2 : 0;
}

// ─────────────────────────────────────────────────────────────────
//  Random-effects meta-analysis.
//  DerSimonian–Laird τ² with the Hartung–Knapp–Sidik–Jonkman
//  variance correction (recommended when k is small, as here), plus
//  a 95% prediction interval (Higgins, Thompson & Spiegelhalter 2009).
//
//  Input: [{ y, se }] on an additive scale (log ratio or SMD).
// ─────────────────────────────────────────────────────────────────
function randomEffectsHK(studies) {
  const k = studies.length;
  if (k < 2) return null;
  const w = studies.map(s => 1 / (s.se * s.se));
  const sw = w.reduce((a, b) => a + b, 0);
  const yFixed = studies.reduce((a, s, i) => a + w[i] * s.y, 0) / sw;
  const Q = studies.reduce((a, s, i) => a + w[i] * (s.y - yFixed) ** 2, 0);
  const C = sw - w.reduce((a, b) => a + b * b, 0) / sw;
  const tau2 = Math.max(0, (Q - (k - 1)) / C);
  const I2 = Q > 0 ? Math.max(0, (Q - (k - 1)) / Q) : 0;

  const wr = studies.map(s => 1 / (s.se * s.se + tau2));
  const swr = wr.reduce((a, b) => a + b, 0);
  const mu = studies.reduce((a, s, i) => a + wr[i] * s.y, 0) / swr;

  // HK variance: weighted residual variance scaled by 1/(k-1)
  const qHK = studies.reduce((a, s, i) => a + wr[i] * (s.y - mu) ** 2, 0) / (k - 1);
  // Common modification: never let HK be narrower than the standard RE SE
  const seHK = Math.sqrt(Math.max(qHK, 1) / swr);
  const tCrit = tQuantile(0.975, k - 1);
  const ci = [mu - tCrit * seHK, mu + tCrit * seHK];

  let pi = null;
  if (k >= 3) {
    const tPI = tQuantile(0.975, k - 2);
    const sePI = Math.sqrt(tau2 + seHK * seHK);
    pi = [mu - tPI * sePI, mu + tPI * sePI];
  }
  return { k, mu, se: seHK, ci, pi, tau2, I2, Q };
}

// Standard error of a log ratio from its 95% CI
function seFromRatioCI(lo, hi) {
  if (!(lo > 0) || !(hi > 0) || hi <= lo) return null;
  return (Math.log(hi) - Math.log(lo)) / (2 * 1.959964);
}
function seFromDiffCI(lo, hi) {
  if (!(hi > lo)) return null;
  return (hi - lo) / (2 * 1.959964);
}

module.exports = {
  logGamma, incBeta, betaQuantile, tCdf, tQuantile, normQuantile,
  jeffreysInterval, kishNeff, randomEffectsHK, seFromRatioCI, seFromDiffCI,
};
