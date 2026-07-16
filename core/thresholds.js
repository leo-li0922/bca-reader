// ============================================================
// Trust thresholds and defaults — ONE source of truth.
//
// Every surface (desktop app, phone UI, offline harness) reads these. No client
// may carry its own copy: a threshold typed into a screen's copy is a threshold
// that will silently drift from the one the math actually applies. See ADR 0001.
// ============================================================

// Below this R², the standard curve is not trustworthy enough to read samples
// off. 0.98 is the conventional floor for a lab standard curve.
export const R2_MIN = 0.98;

// Above this CV%, replicate wells are judged to disagree. Applies to standards
// and samples alike. MUST be measured on RAW well signals, never blank-subtracted
// nets — see cvPercent() in stats.js for why.
export const CV_MAX = 15;

// A ladder rung counts as "off the curve" when its measured signal sits further
// from the fit than BOTH of these allow: a relative slack, and a floor expressed
// as a fraction of the ladder's own signal range.
//
// The floor MUST stay relative. It was `Math.max(5, ...)` inside app.js until
// 2026-07-16 — an absolute noise floor in photo units, where signal is
// (255 - green) and runs 0..255. An instrument OD runs 0..2, so a floor of 5 made
// the flag unfireable on the OD path: the diagnostic was dead and looked healthy.
// Any absolute number here re-breaks that the moment a third signal source lands.
export const RUNG_OFF_RELATIVE = 0.15;
export const RUNG_OFF_FLOOR_FRACTION = 0.02;

// The default curve fit. 4PL became the default on 2026-07-14 after the first
// real-plate validation: linear read one control as 552 µg/mL against a true 286,
// and the quadratic turned over inside the range and printed 3191 on a blank.
//
// This is a PHOTO-path default and the OD path overrules it — correctly. See
// CONTEXT.md → "The OD path fits quad, not 4PL — by design". The turn-over
// warning above was measured on photo data and does not hold on OD.
export const DEFAULT_FIT = "4pl";

// The green channel is the default signal. BCA's product is purple, which
// absorbs green, so green darkens as protein rises.
export const DEFAULT_CHANNEL = "green";
