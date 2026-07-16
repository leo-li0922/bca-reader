// ============================================================
// The BCA Reader core: the single source of truth for the science.
//
// Nothing in here touches the DOM. Every surface — the desktop app, any future
// phone UI, the offline validation harness — imports from this one module and
// none of them may carry their own copy of a fit, a threshold, or a constant.
// A threshold typed into a screen's copy is a threshold that will drift.
//
// See docs/adr/0001-extract-math-core.md.
// ============================================================

export { mean, cvPercent } from "./stats.js";
export {
  fitStandards,
  linearFit,
  quadraticFit,
  invertQuadratic,
  fourPLFit,
  solveN,
  solve3,
  rSquared,
} from "./fits.js";
export { sampleColorAt, colorToSignal } from "./signal.js";
export { ROWS, COLS, wellName, lerp, buildGrid, SBS, wellFraction } from "./plate.js";
export {
  R2_MIN,
  CV_MAX,
  DEFAULT_FIT,
  DEFAULT_CHANNEL,
  RUNG_OFF_RELATIVE,
  RUNG_OFF_FLOOR_FRACTION,
} from "./thresholds.js";
export { computeConcentrations } from "./compute.js";
export { parsePlateBlock, applyBlockToWells, EMPTY_CELL } from "./import.js";
export {
  planLoading,
  LOADING_DEFAULTS,
  DILUTION_NOTE,
  MIN_PIPETTE_UL,
  DYE_X_MIN,
  DYE_X_MAX,
} from "./loading.js";
