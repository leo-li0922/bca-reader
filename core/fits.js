// ============================================================
// Curve fitting — returns a uniform model object so the rest of
// the app never has to care which kind of fit was used:
//   { type, r2, predict(conc)->signal, invert(signal)->conc, equation }
//
// Pure; no DOM. Moved verbatim out of bca-reader/app.js on 2026-07-15 (ADR 0001);
// the numbers must not drift, and validation/baseline-plate-3124.txt proves it.
// ============================================================

import { mean } from "./stats.js";

// ============================================================
// Formatting a fitted coefficient for display.
//
// SIGNIFICANT FIGURES, NEVER FIXED DECIMALS. This is the project's own scar
// tissue, and it is worth the paragraph.
//
// A real lab spreadsheet divided ΔOD by 0.0007 — an Excel trendline label rounded
// to ONE significant figure from a true slope of 0.000741 — and every
// concentration it produced came out ~5.9% high. That single rounded label is the
// error this project spent 2026-07-16 proving (CONTEXT.md → "RESOLVED 2026-07-16").
//
// This file printed the SAME `0.0007`, for the SAME coefficient, until that same
// day. `toFixed(4)` keeps four DECIMALS, which on an OD slope is one sig fig. The
// fit itself was always full-precision — only the label lied — but a label is
// exactly what a human copies into a calculator, so it is exactly what bites.
//
// The general rule, now that this app has two signal scales (photo 0..255, OD
// 0..2): a coefficient's magnitude depends on the scale, so ANY fixed number of
// decimals is correct for one scale and wrong for the other. Significant figures
// are scale-free. Do not reintroduce toFixed() here.
// Four sig figs is enough to re-derive the fit by hand without the label being
// the limiting factor. Below 1e-4 plain decimals stop being readable
// (0.00004187), so those go exponential — same 4 sig figs either way.
const COEF_SIG = 4;
const COEF_EXP_BELOW = 1e-4;
function coef(v) {
  if (!isFinite(v)) return "—";
  if (v === 0) return "0";
  return Math.abs(v) < COEF_EXP_BELOW
    ? Number(v).toExponential(COEF_SIG - 1)
    : Number(v).toPrecision(COEF_SIG);
}

export function fitStandards(points, mode) {
  if (mode === "4pl") return fourPLFit(points);
  return mode === "quad" ? quadraticFit(points) : linearFit(points);
}

// Straight line: signal = slope·conc + intercept (ordinary least squares).
export function linearFit(points) {
  const n = points.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxy += p.x * p.y; sxx += p.x * p.x; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  const predict = (c) => slope * c + intercept;
  const r2 = rSquared(points, predict);
  return {
    type: "linear",
    r2,
    slope,
    intercept,
    predict,
    invert: (y) => (slope !== 0 ? (y - intercept) / slope : NaN),
    equation: `signal = ${coef(slope)} × conc + ${coef(intercept)}`,
  };
}

// Quadratic: signal = a·conc² + b·conc + c. A gentle curve that tracks the
// real BCA reaction's flattening at high concentrations far better than a line,
// without needing an iterative (and fragile) 4-parameter logistic solver.
export function quadraticFit(points) {
  // Need 3+ distinct points for a quadratic; fall back to a line otherwise.
  if (points.length < 3) return linearFit(points);

  // Build and solve the 3×3 normal equations for least squares.
  let s0 = points.length, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0; // sums of y·x^k
  for (const p of points) {
    const x = p.x, x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += p.y; t1 += p.y * x; t2 += p.y * x2;
  }
  // Matrix is [[s4 s3 s2 | t2],[s3 s2 s1 | t1],[s2 s1 s0 | t0]] → [a,b,c]
  const sol = solveN([
    [s4, s3, s2, t2],
    [s3, s2, s1, t1],
    [s2, s1, s0, t0],
  ]);
  if (!sol) return linearFit(points); // singular → safe fallback

  const [a, b, c] = sol;
  const predict = (conc) => a * conc * conc + b * conc + c;
  const r2 = rSquared(points, predict);
  const xMax = Math.max(...points.map((p) => p.x));
  return {
    type: "quad",
    r2,
    a, b, c,
    predict,
    invert: (y) => invertQuadratic(a, b, c, y, xMax),
    equation: `signal = ${coef(a)}·conc² + ${coef(b)}·conc + ${coef(c)}`,
  };
}

// Solve a·conc² + b·conc + c = y for conc. Pick the smallest non-negative real
// root that sits in the standard range (the assay's rising branch).
export function invertQuadratic(a, b, c, y, xMax) {
  if (Math.abs(a) < 1e-12) {
    return b !== 0 ? (y - c) / b : NaN; // effectively linear
  }
  const disc = b * b - 4 * a * (c - y);
  if (disc < 0) return NaN;
  const root = Math.sqrt(disc);
  const r1 = (-b + root) / (2 * a);
  const r2 = (-b - root) / (2 * a);
  const candidates = [r1, r2]
    .filter((r) => isFinite(r) && r >= -1e-6)
    .map((r) => Math.max(r, 0))
    .filter((r) => r <= xMax * 1.5); // allow modest extrapolation, reject wild roots
  if (!candidates.length) {
    // No in-range root: return whichever non-negative root exists, else NaN.
    const nn = [r1, r2].filter((r) => isFinite(r) && r >= 0);
    return nn.length ? Math.min(...nn) : NaN;
  }
  return Math.min(...candidates);
}

// 4-parameter logistic (4PL): signal = d + (a − d) / (1 + (conc/c)^b)
//   a = signal at zero protein      d = the saturation ceiling
//   c = conc at half-height         b = how steeply it climbs
//
// This is the shape the BCA reaction genuinely has: it rises, then flattens
// onto a ceiling and stays there. The quadratic only IMITATES that flattening,
// and it cannot hold the imitation — a parabola must turn back down after its
// vertex. On a real 0–2000 µg/mL series the vertex lands inside the range, so
// high signals map to two different concentrations and inversion has to guess.
// A logistic is monotonic forever, so every signal reads back to exactly one
// concentration. That is the whole reason this fit exists.
//
// No closed form, so it is solved iteratively by Levenberg–Marquardt: start
// from a sensible guess, and repeatedly take a step that reduces squared error,
// sliding between cautious gradient-descent (large λ) and fast Gauss–Newton
// (small λ) depending on whether the last step helped.
export function fourPLFit(points) {
  if (points.length < 4) return quadraticFit(points); // 4 params need 4+ points
  const ys = points.map((p) => p.y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const positive = points.filter((p) => p.x > 0);
  if (!positive.length || yMax === yMin) return quadraticFit(points);

  // signal for one x, given params P = [a, b, c, d]. At conc 0 the (conc/c)^b
  // term vanishes and the model collapses to exactly `a`.
  const model = (P, x) => {
    const [a, b, c, d] = P;
    if (x <= 0) return a;
    return d + (a - d) / (1 + Math.pow(x / c, b));
  };

  // Partial derivatives ∂signal/∂[a,b,c,d] — the Jacobian row LM needs.
  // At conc 0 the curve is pinned to `a`, so only ∂/∂a is non-zero there
  // (this also dodges log(0) in the ∂/∂b term).
  const grad = (P, x) => {
    const [a, b, c, d] = P;
    if (x <= 0) return [1, 0, 0, 0];
    const u = Math.pow(x / c, b);
    const den = 1 + u;
    return [
      1 / den,                                        // ∂/∂a
      (-(a - d) * u * Math.log(x / c)) / (den * den), // ∂/∂b
      ((a - d) * b * u) / (c * den * den),            // ∂/∂c
      u / den,                                        // ∂/∂d
    ];
  };

  const sse = (P) => points.reduce((s, p) => s + (p.y - model(P, p.x)) ** 2, 0);

  // Initial guess: floor at the lowest signal, ceiling just above the highest,
  // half-height at whichever standard sits nearest the midpoint, plain slope.
  const half = (yMin + yMax) / 2;
  let cGuess = positive[0].x, bestGap = Infinity;
  for (const p of positive) {
    const gap = Math.abs(p.y - half);
    if (gap < bestGap) { bestGap = gap; cGuess = p.x; }
  }
  let P = [yMin, 1, cGuess, yMax + (yMax - yMin) * 0.05 + 1e-6];
  let err = sse(P);
  let lambda = 1e-3;

  for (let iter = 0; iter < 500; iter++) {
    // Accumulate JᵀJ and Jᵀr over every standard.
    const JTJ = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const JTr = [0, 0, 0, 0];
    for (const p of points) {
      const g = grad(P, p.x);
      const r = p.y - model(P, p.x);
      for (let i = 0; i < 4; i++) {
        JTr[i] += g[i] * r;
        for (let j = 0; j < 4; j++) JTJ[i][j] += g[i] * g[j];
      }
    }
    // Damped system (JᵀJ + λ·diag)·δ = Jᵀr
    const aug = [];
    for (let i = 0; i < 4; i++) {
      const row = JTJ[i].slice();
      row[i] += lambda * (JTJ[i][i] || 1);
      row.push(JTr[i]);
      aug.push(row);
    }
    const delta = solveN(aug);
    if (!delta) { lambda *= 10; if (lambda > 1e12) break; continue; }

    const cand = P.map((v, i) => v + delta[i]);
    // Reject physically impossible steps: slope and half-point must stay
    // positive and the ceiling must stay above the floor, else LM can wander
    // into a mirrored solution that fits the points but inverts backwards.
    const sane =
      cand.every((v) => isFinite(v)) &&
      cand[1] > 1e-6 && cand[2] > 1e-6 && cand[3] > cand[0];
    if (!sane) { lambda *= 10; if (lambda > 1e12) break; continue; }

    const candErr = sse(cand);
    if (candErr < err) {
      const gain = err - candErr;
      P = cand; err = candErr;
      lambda = Math.max(lambda / 10, 1e-12);
      if (gain < 1e-12) break; // converged
    } else {
      lambda *= 10;
      if (lambda > 1e12) break;
    }
  }

  const [a, b, c, d] = P;
  const predict = (conc) => model(P, conc);
  const r2 = rSquared(points, predict);

  // If the iteration failed to beat the quadratic, don't ship a worse curve.
  const quad = quadraticFit(points);
  if (!isFinite(r2) || r2 < quad.r2) return quad;

  return {
    type: "4pl",
    r2, a, b, c, d,
    predict,
    // conc = c · [ (a−d)/(y−d) − 1 ]^(1/b).
    // Only defined strictly between the two asymptotes. Outside them the assay
    // carries no information at all, so return NaN and let the caller flag it
    // rather than invent a number the chemistry cannot support.
    invert: (y) => {
      const lo = Math.min(a, d), hi = Math.max(a, d);
      if (!(y > lo && y < hi)) return NaN;
      const ratio = (a - d) / (y - d) - 1;
      if (!(ratio > 0)) return NaN;
      const conc = c * Math.pow(ratio, 1 / b);
      return isFinite(conc) ? conc : NaN;
    },
    equation: `signal = ${coef(d)} + (${coef(a)} − ${coef(d)}) / (1 + (conc/${coef(c)})^${coef(b)})`,
  };
}

// Gaussian elimination with partial pivoting on an n×(n+1) augmented matrix.
// Returns null if the matrix is singular.
//
// ONE solver, both callers. There used to be a `solve3` beside this — a
// character-for-character copy specialised to the quadratic's 3×4 matrix,
// differing only in its singularity tolerance (1e-12 here vs 1e-14). Two copies
// of an elimination is two places to fix a pivoting bug and one place to forget,
// and the loop bounds were the only thing the specialisation bought. Removed
// 2026-07-16 with validation/baseline-plate-3124.txt byte-identical across all
// three fits, so the epsilon band between 1e-14 and 1e-12 provably holds nothing
// the real plate lands in.
//
// The tolerance is ABSOLUTE and that is a known soft spot, not an oversight: the
// quadratic's normal equations carry Σx⁴, which on a 0–2000 µg/mL ladder is ~1e13,
// so no fixed epsilon is scale-free here. It is a backstop against an exactly
// degenerate matrix (every standard at one concentration), not a conditioning
// test — and compute.js refuses a ladder with fewer than 2 distinct
// concentrations long before this sees it, which is where the degenerate case
// is actually caught. Nothing pins that null return independently: no unit test
// reaches this branch, so treat it as reasoned-about, not verified.
export function solveN(m) {
  const n = m.length;
  const a = m.map((row) => row.slice());
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < 1e-14) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let k = col; k <= n; k++) a[r][k] -= f * a[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = a[r][n];
    for (let k = r + 1; k < n; k++) sum -= a[r][k] * x[k];
    x[r] = sum / a[r][r];
  }
  return x;
}

// R² for any predictor function.
export function rSquared(points, predict) {
  const meanY = mean(points.map((p) => p.y));
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    ssTot += (p.y - meanY) ** 2;
    ssRes += (p.y - predict(p.x)) ** 2;
  }
  return ssTot === 0 ? 1 : 1 - ssRes / ssTot;
}
