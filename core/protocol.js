// ============================================================
// The assay protocol's own constants — what the KIT says, not what the app
// decides. Pure data; no DOM, no arithmetic.
//
// WHY THIS IS NOT thresholds.js. A threshold is this app's judgement call — how
// bad an R² has to be before we stop trusting it — and we could argue about it.
// What is in here is not ours to argue about: it is the series that comes in the
// box. Different kind of number, different lifetime, different file.
//
// WHY IT IS NOT IN THE UI. This ladder lived in bca-reader/app.js as
// `LADDER_DEFAULTS` until 2026-07-16, which made a plate constant a property of
// one screen — exactly what ADR 0001 exists to stop. It prefills the ladder
// fields, but it also describes the plate the harness reads and the plate any
// future surface will read, and those must not each keep their own copy of it.
// ============================================================

// The standard BSA 2-fold serial dilution, top row down: A=0 (the blank rung)
// through H=2000 µg/mL. This is the near-universal BCA ladder — it is the series
// the validation plate was actually run with (CONTEXT.md's plate map: ladder in
// columns 1-3, rows A-H, 0 … 2000, which is the ladder truth every number in
// validation/baseline-plate-3124.txt is read against).
//
// It is a PREFILL, never an assumption. Nothing downstream infers a
// concentration from a row's position: compute.js reads the value the user
// confirmed on the well (`w.conc`), so a plate run with a different ladder is
// simply typed in and works. The 8 values line up with the 8 plate rows on
// purpose — a plate whose ladder runs across columns instead needs the values
// entered by hand, not this array reversed.
export const BSA_LADDER_UGML = [0, 31.25, 62.5, 125, 250, 500, 1000, 2000];
