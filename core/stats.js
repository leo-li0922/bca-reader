// ============================================================
// Replicate statistics. Pure; no DOM.
// ============================================================

export function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// Coefficient of variation as a percent (sample stddev / mean × 100). 0 for a
// single value. This is the standard lab measure of replicate agreement.
// MUST be fed RAW well signals, never blank-subtracted nets: CV asks "do these
// wells agree?", which is a property of the wells themselves. On nets, the mean
// approaches zero near the blank while the spread does not, so the ratio blows
// up and low standards get flagged as disagreeing when they are in fact fine.
export function cvPercent(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  if (m === 0) return 0;
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return (Math.sqrt(variance) / Math.abs(m)) * 100;
}
