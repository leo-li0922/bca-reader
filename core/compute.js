// ============================================================
// The read: tagged wells in, concentrations out.
//
// This is the function every surface calls and nothing may duplicate. It is pure
// arithmetic — no DOM, no canvas, no alert, no rendering. It does not know
// whether its colors came from a browser canvas or a Python sampler, which is
// exactly why the offline harness can now import it instead of evaluating the
// whole app inside a fake DOM (ADR 0001).
//
// Correct workflow, per the research brief: replicate → blank-subtract → fit →
// check → read, and never extrapolate.
// ============================================================

import { mean, cvPercent } from "./stats.js";
import { fitStandards } from "./fits.js";
import { colorToSignal } from "./signal.js";
import {
  R2_MIN,
  CV_MAX,
  DEFAULT_FIT,
  DEFAULT_CHANNEL,
  RUNG_OFF_RELATIVE,
  RUNG_OFF_FLOOR_FRACTION,
} from "./thresholds.js";

/**
 * @param wells  Array of well objects. Every well with a role other than
 *               "unused" must carry EITHER a `.color` ({r,g,b}) or an already-
 *               measured `.signal`.
 *
 *               Colour is the PHOTO path's way of producing a signal, not the
 *               only way. Pixels are an edge concern — the browser samples its
 *               canvas, the harness injects sampled values — but a plate reader
 *               has already done the measuring, and its OD *is* the signal
 *               (core/import.js). Everything below this line is identical either
 *               way, which is the point: the fit, the stats and the thresholds
 *               never learn where the number came from.
 * @param opts   { channel, fitMode }
 * @returns      { ok: true, fit, standardPts, sampleResults, warnings }
 *               | { ok: false, error }
 *
 * Note: like the original, this mirrors each group's estConc back onto its
 * member wells so CSV export can read it off the well. That mutation is
 * deliberate and behaviour-preserving.
 */
export function computeConcentrations(wells, opts = {}) {
  const channel = opts.channel || DEFAULT_CHANNEL;
  const fitMode = opts.fitMode || DEFAULT_FIT;

  // 1. Make sure every tagged well has a signal.
  //    Photo path: derive it from the sampled colour. Instrument path: it is
  //    already there (the OD), so leave it alone. A tagged well with neither used
  //    to throw a TypeError out of colorToSignal; now it is a stated error,
  //    because "you tagged a well the instrument never read" is a sentence a user
  //    can act on and a stack trace is not.
  for (const w of wells) {
    if (w.role === "unused") continue;
    if (w.color) {
      w.signal = colorToSignal(w.color, channel);
    } else if (!isFinite(w.signal)) {
      return {
        ok: false,
        error: `Well ${w.name} is tagged as a ${w.role} but has no reading. Untag it, or paste a block that covers it.`,
      };
    }
  }

  // 2. Blank baseline = average signal of all blank wells (0 if none tagged).
  const blanks = wells.filter((w) => w.role === "blank");
  const blankSignal = blanks.length ? mean(blanks.map((w) => w.signal)) : 0;

  // 3. Standards: AVERAGE replicate wells at the same concentration.
  //    Blank wells join as the 0-concentration group. We group by concentration
  //    so three wells at 500 µg/mL become one curve point (their mean), and we
  //    measure how much they disagree (CV%) to flag noisy standards.
  const stdGroups = new Map(); // conc -> { nets, raws }
  for (const w of wells) {
    if (w.role === "standard" || w.role === "blank") {
      const conc = w.role === "blank" ? 0 : w.conc;
      if (!stdGroups.has(conc)) stdGroups.set(conc, { nets: [], raws: [] });
      const g = stdGroups.get(conc);
      g.nets.push(w.signal - blankSignal); // curve height: blank-subtracted
      g.raws.push(w.signal);               // agreement: raw, see cvPercent
    }
  }
  // One curve point per concentration (the replicate mean).
  const standardPts = [];
  for (const [conc, g] of stdGroups) {
    standardPts.push({ x: conc, y: mean(g.nets), n: g.nets.length, cv: cvPercent(g.raws) });
  }
  standardPts.sort((a, b) => a.x - b.x);

  if (standardPts.length < 2) {
    // The core states the problem; the edge decides how to say it. This used to
    // be an alert() fired from inside the math.
    return {
      ok: false,
      error: "Tag at least one blank and one standard (2+ concentrations) to fit a curve.",
    };
  }

  // Concentration range the standards actually cover. Reading a sample outside
  // this range is extrapolation — the curve is not validated there.
  const concVals = standardPts.map((p) => p.x);
  const stdMin = Math.min(...concVals);
  const stdMax = Math.max(...concVals);

  // 4. Fit the chosen model.
  //
  //    NOTE: fitMode is a REQUEST, not a command. fitStandards("4pl") fits a 4PL
  //    and then refuses to ship it if a quadratic scores better (fits.js). On
  //    instrument ODs the quadratic always wins — the 4PL exists to correct the
  //    CAMERA's ceiling, and an instrument has no camera. So the OD path self-
  //    selects away from the default and that is correct. See CONTEXT.md →
  //    "The OD path fits quad, not 4PL — by design".
  const fit = fitStandards(standardPts, fitMode);

  // Per-rung residual: did this standard land where the curve says it should?
  // A rung far off the curve is the tell that its row is sampling the wrong
  // pixels — the single most useful diagnostic the app has (CONTEXT.md: "when a
  // read is wrong, suspect grid alignment, not the math").
  //
  // The floor is a FRACTION OF THE LADDER'S OWN SIGNAL RANGE, never an absolute
  // number. It lived in app.js as `Math.max(5, ...)` until 2026-07-16, where the
  // 5 was a noise floor in photo units (signal = 255 - green, so 0..255). An
  // instrument OD runs 0..2, so that flag could not fire AT ALL on the OD path:
  // the one readout built to catch a bad rung was silently dead on arrival.
  // Scaling it to the data is what makes one threshold serve both signals.
  const ys = standardPts.map((p) => p.y);
  const signalRange = Math.max(...ys) - Math.min(...ys);
  for (const p of standardPts) {
    p.fit = fit.predict(p.x);
    p.off =
      isFinite(p.fit) &&
      Math.abs(p.y - p.fit) >
        Math.max(RUNG_OFF_FLOOR_FRACTION * signalRange, RUNG_OFF_RELATIVE * Math.abs(p.fit));
  }

  // 5. Samples: AVERAGE replicate wells that share a label, then read off the fit.
  const sampleGroups = new Map(); // label -> { nets, raws }
  const sampleWells = wells.filter((w) => w.role === "sample");
  for (const w of sampleWells) {
    const key = w.label || w.name;
    if (!sampleGroups.has(key)) sampleGroups.set(key, { nets: [], raws: [] });
    const g = sampleGroups.get(key);
    g.nets.push(w.signal - blankSignal);
    g.raws.push(w.signal);
  }

  const sampleResults = [];
  for (const [label, g] of sampleGroups) {
    const nets = g.nets;
    const netSignal = mean(nets);
    const cv = cvPercent(g.raws);
    const estConc = fit.invert(netSignal);
    const flags = [];
    if (nets.length > 1 && cv > CV_MAX) flags.push(`replicates disagree (CV ${cv.toFixed(0)}%)`);
    if (isFinite(estConc) && (estConc < stdMin || estConc > stdMax)) {
      flags.push("outside standard range (extrapolated)");
    }
    if (!isFinite(estConc)) flags.push("could not read off curve");
    sampleResults.push({ label, n: nets.length, netSignal, cv, estConc, flags });
    // Mirror the group result back onto every well so CSV export still works.
    for (const w of sampleWells) {
      if ((w.label || w.name) === label) w.estConc = estConc;
    }
  }

  // 6. Run-level trust warnings (about the whole fit, not one sample).
  const warnings = [];
  if (fit.r2 < R2_MIN) {
    warnings.push(`Standard curve fit is weak (R² = ${fit.r2.toFixed(3)}). Re-shoot the plate with even lighting, or try the other curve fit.`);
  }
  for (const p of standardPts) {
    if (p.n > 1 && p.cv > CV_MAX) {
      warnings.push(`Standard at ${p.x} µg/mL: replicate wells disagree (CV ${p.cv.toFixed(0)}%).`);
    }
  }
  const extrapolated = sampleResults.filter((s) => s.flags.some((f) => f.includes("range")));
  if (extrapolated.length) {
    warnings.push(`${extrapolated.length} sample(s) fall outside the standard range (${stdMin}–${stdMax} µg/mL). Those reads are extrapolated — dilute and re-run, or add standards that bracket them.`);
  }

  return { ok: true, fit, standardPts, sampleResults, warnings };
}
