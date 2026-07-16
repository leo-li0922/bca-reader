// ============================================================
// The gel loading plan: concentrations in, pipetting volumes out.
//
// Step 7 answers "how much protein is in my sample?". This answers the question
// a BCA is actually RUN in order to answer: "how many µL of each sample do I load
// into each well of the western blot gel so every lane carries the same protein
// mass?"
//
// Pure arithmetic, no DOM — same contract as the rest of core/ (ADR 0001). The
// app and the harness both import this; neither may carry its own copy of a
// volume rule or a cutoff.
//
// MODELLED ON A REAL LAB'S PREP SHEET, not a textbook. (Which sheet, and which
// run, is recorded in the project's private validation notes; it is provenance,
// and it would tell a reader of this file nothing they need.) The sheet's western
// blot prep sat unread beside the OD data we were already using, until 2026-07-16
// — the loading recipe had been in the repo all along. Its formulas, cell by cell:
//
//   H = ΔOD / 0.0007      conc of the DILUTED well          → 286.4 µg/mL
//   I = H * 10            ×10 dilution → STOCK lysate       → 2864.3 µg/mL
//   J = 225 / I           mL of stock holding 225 µg        → 0.0786 mL
//   K = J * 1000          → µL OF SAMPLE                    → 78.55 µL
//   L = 90 - K            → µL OF LYSIS BUFFER              → 11.45 µL
//   M = 30                → µL OF 4x LAEMMLI (fixed)
//   O22 = 225/120 = 1.875 µg/µL, O23 = *18 = 33.75 µg per 18 µL lane
//
// Note 90 = 120 − 30: the sample and the lysis buffer share whatever the dye
// does not occupy. That is the whole shape of the calculation, and it is why
// `dyeVolume` is derived from `finalVolume` and never entered by hand.
//
// WHAT THIS MODULE IS AND IS NOT RESPONSIBLE FOR:
//
// The arithmetic here is the sheet's, exactly — tools/check-loading-plan.js
// proves it reproduces every cell to 1e-9. What changes is the CONCENTRATION fed
// in: the sheet reads it off the plate reader, the app reads it off a photo — or,
// since 2026-07-16, off the plate reader's own numbers pasted in (core/import.js).
// That input is where all the disagreement lives, and it is not this module's to
// fix. Measured on the validation plate (sample µL for 225 µg, ×10 dilution):
//
//              app's PHOTO read   the sheet   app's OD read   corrected-slope truth
//   sample 1        78.75          78.55         82.67              83.21
//   sample 2        68.95          72.26         75.50              76.53
//   sample 3        64.25          74.58         78.13              79.00
//   sample 4        92.71          93.09         99.72              98.60
//
// Three things to take from that table, none of them obvious:
//
// 1. The two right-hand columns agree, and they are the ones to trust. Feeding
//    the plate reader's OWN ODs through this app's own fit lands within ~1% of
//    the corrected-slope truth — which is what RESOLVED the open question this
//    comment used to point at (CONTEXT.md → "RESOLVED 2026-07-16"). The sheet
//    divides ΔOD by 0.0007, a trendline label rounded to one significant figure
//    against a real slope of 0.000741, so it runs ~5.9% high and asks for ~5 µL
//    too little sample per tube.
//
//    The photo column tracks the SHEET, not the truth — and that is now known to
//    be two errors cancelling, not agreement: the photo reads ~5% high and the
//    sheet is ~5.9% high. So the project's old "4.5% error" was the distance to
//    an inflated target. Against the corrected truth the photo path is ~5% high.
//    Do not quote 4.5%.
//
// 2. Per-sample agreement is much worse than the mean error suggests: sample 3
//    is off by 14%, which is a known LIGHTING GRADIENT (CONTEXT.md), not a fit
//    problem. Averaged across four samples that hides inside a single figure.
//
// 3. Which is why this step raises the stakes on controlled lighting. A 14% read
//    error used to be a number on a screen. Here it becomes 10 µL of lysate that
//    does or does not go in the tube, and a lane that silently carries the wrong
//    mass — the exact thing loading equal mass was supposed to prevent.
//
// THE ONE PLACE WE DELIBERATELY DIVERGE: we flag what Excel prints silently. On
// the source sheet one sample came out at 90 − 93.09 = −3.09 µL of lysis buffer:
// a NEGATIVE volume, meaning it was too dilute to fit 225 µg in the space
// available. Excel showed a minus sign and nothing else. Here it is a flag with
// a way out.
// ============================================================

// Defaults are a real lab's prep numbers, so the app opens on a protocol someone
// actually runs instead of a textbook guess. Every one is editable in the UI.
export const LOADING_DEFAULTS = {
  dilutionFactor: 1, // ×1 = undiluted. The source sheet used 10. See DILUTION_NOTE.
  targetMass: 225, // µg of protein per prepped tube
  finalVolume: 120, // µL total once dye is in
  dyeX: 4, // 4x Laemmli → dye takes 1/4 of the final volume
  loadPerLane: 18, // µL pipetted into each gel well
};

// Why the dilution factor defaults to 1 and not to the source sheet's 10: a wrong
// dilution factor is a silent, exactly-proportional error in every volume on the
// plan, and it cannot be caught by looking at the output. 1 is the value that
// changes nothing, so the damage of forgetting the field is zero rather than 10x.
export const DILUTION_NOTE =
  "The concentration in Step 7 is what was in the plate well. If you diluted your lysate before the assay, enter that factor here — the plan needs the stock concentration.";

// Below this, a volume is at the edge of what a P20 places reliably, and the
// mass in the lane inherits that error. Not a hard stop; a flag.
export const MIN_PIPETTE_UL = 2;

// A sane ceiling for the dye multiplier field. 2x/4x/6x Laemmli are the ones on
// real bench shelves; the field is free-entry so this only catches typos.
export const DYE_X_MIN = 1.5;
export const DYE_X_MAX = 10;

/**
 * Build the per-sample pipetting plan.
 *
 * @param sampleResults  The `sampleResults` array from computeConcentrations():
 *                       [{ label, estConc, flags, ... }]. estConc is µg/mL AS
 *                       READ FROM THE PLATE — i.e. post-dilution, if diluted.
 * @param opts           Partial LOADING_DEFAULTS override.
 * @returns { ok: true, rows, shared, warnings } | { ok: false, error }
 *
 * `shared` holds the numbers that are the same for every tube (dye volume, the
 * sample+buffer budget, the final concentration, µg per lane) — they are a
 * property of the protocol, not of any one sample, so they are computed once and
 * live outside the rows.
 */
export function planLoading(sampleResults, opts = {}) {
  const o = { ...LOADING_DEFAULTS, ...opts };

  // Guard the inputs before dividing by any of them. Each of these is a field a
  // user can empty or typo, and every one of them is a denominator or a budget.
  if (!(o.targetMass > 0)) {
    return { ok: false, error: "Target mass must be greater than 0 µg." };
  }
  if (!(o.finalVolume > 0)) {
    return { ok: false, error: "Final volume must be greater than 0 µL." };
  }
  if (!(o.dyeX >= DYE_X_MIN && o.dyeX <= DYE_X_MAX)) {
    return { ok: false, error: `Loading dye strength must be between ${DYE_X_MIN}x and ${DYE_X_MAX}x.` };
  }
  if (!(o.dilutionFactor > 0)) {
    return { ok: false, error: "Dilution factor must be greater than 0 (use 1 for undiluted)." };
  }
  if (!(o.loadPerLane > 0)) {
    return { ok: false, error: "Volume per lane must be greater than 0 µL." };
  }
  if (!sampleResults || !sampleResults.length) {
    return { ok: false, error: "No samples to plan. Tag some sample wells first." };
  }

  // Dye is a fixed fraction of the FINAL volume: 4x Laemmli must end up at 1x,
  // so it occupies 1/4 of the tube. Everything else shares what is left.
  const dyeVolume = o.finalVolume / o.dyeX;
  const budget = o.finalVolume - dyeVolume; // the sheet's 90 µL (= 120 − 30)

  // The tube's final protein concentration and what one lane therefore carries.
  // These do not depend on any sample: they are what the protocol was designed
  // to deliver, and every sample is made to hit them.
  const finalConc = o.targetMass / o.finalVolume; // µg/µL (sheet: 1.875)
  const massPerLane = finalConc * o.loadPerLane; // µg    (sheet: 33.75)

  if (o.loadPerLane > o.finalVolume) {
    return {
      ok: false,
      error: `You cannot load ${o.loadPerLane} µL per lane from a ${o.finalVolume} µL tube. Lower the volume per lane or raise the final volume.`,
    };
  }

  const rows = [];
  for (const s of sampleResults) {
    const readConc = s.estConc; // µg/mL, as read off the curve
    const row = {
      label: s.label,
      readConc,
      stockConc: NaN,
      sampleUl: NaN,
      bufferUl: NaN,
      dyeUl: dyeVolume,
      // Step 7's own doubts travel with the sample. A volume computed from a
      // read that was extrapolated or had disagreeing replicates is exactly as
      // untrustworthy as that read, and the plan is where it gets acted on.
      flags: [...(s.flags || [])],
    };

    if (!isFinite(readConc) || readConc <= 0) {
      row.flags.push("no usable concentration — cannot plan this sample");
      rows.push(row);
      continue;
    }

    // Undo the pre-assay dilution to recover the stock lysate (sheet: I = H*10).
    row.stockConc = readConc * o.dilutionFactor; // µg/mL
    const stockUgPerUl = row.stockConc / 1000; // µg/mL → µg/µL

    row.sampleUl = o.targetMass / stockUgPerUl; // sheet: K = (225/I)*1000
    row.bufferUl = budget - row.sampleUl; // sheet: L = 90 − K

    // The too-dilute case. The sample cannot carry targetMass in the space
    // the dye leaves, so the sheet's subtraction goes negative. Say what is
    // actually achievable instead of printing a volume nobody can pipette.
    if (row.bufferUl < 0) {
      const maxMass = stockUgPerUl * budget;
      row.flags.push(
        `too dilute — ${o.targetMass} µg needs ${row.sampleUl.toFixed(1)} µL but only ${budget.toFixed(1)} µL is free. Max here is ${maxMass.toFixed(0)} µg, or raise the final volume.`
      );
    } else if (row.sampleUl < MIN_PIPETTE_UL) {
      row.flags.push(
        `only ${row.sampleUl.toFixed(1)} µL of sample — below ${MIN_PIPETTE_UL} µL the pipetting error lands straight in the lane. Dilute the stock, or raise the target mass.`
      );
    }

    rows.push(row);
  }

  // Run-level warnings: about the plan as a whole, not one tube. Same division of
  // labour as computeConcentrations() — the core states the problem, the edge
  // decides how to say it.
  const warnings = [];

  const tooDilute = rows.filter((r) => r.bufferUl < 0);
  if (tooDilute.length) {
    // The binding constraint is the weakest sample: matching mass across lanes
    // means every lane is capped by whichever one has the least protein.
    const worst = Math.min(
      ...tooDilute.map((r) => (r.stockConc / 1000) * budget)
    );
    warnings.push(
      `${tooDilute.length} sample(s) cannot reach ${o.targetMass} µg in ${o.finalVolume} µL. To keep every lane equal, drop the target to about ${Math.floor(worst / 5) * 5} µg, or raise the final volume.`
    );
  }

  if (o.dilutionFactor === 1) {
    warnings.push(
      `Dilution factor is 1 (undiluted). If you diluted your lysate before the assay, these volumes are wrong by exactly that factor.`
    );
  }

  const carried = rows.filter((r) =>
    r.flags.some((f) => f.includes("range") || f.includes("CV"))
  );
  if (carried.length) {
    warnings.push(
      `${carried.length} sample(s) carry a warning from Step 7. A volume is only as good as the concentration it came from — fix the read before trusting the plan.`
    );
  }

  return {
    ok: true,
    rows,
    shared: { dyeVolume, budget, finalConc, massPerLane, ...o },
    warnings,
  };
}
