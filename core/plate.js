// ============================================================
// Plate geometry. Pure; no DOM.
// ============================================================

// Standard 96-well = 8 rows (A-H) x 12 cols (1-12).
export const ROWS = 8;
export const COLS = 12;

// How many wells one sample occupies in a row. Triplicate is the near-universal
// default on a BCA plate; the UI lets you change it.
export const DEFAULT_REPLICATES = 3;

// ============================================================
// Splitting a row of sample wells into the samples it actually holds.
//
// THE PROBLEM THIS SOLVES. Samples were defined one-per-plate-row: same row =
// replicates. That holds for up to 8 samples in a single block of columns. It
// breaks the moment there are more, because the plate gets a SECOND block beside
// the first — 12 samples = columns 4-6 (rows A-H) plus columns 7-9 (rows A-D) —
// and now row A holds sample 1 AND sample 9. One name per row silently merged
// them: six wells averaged as one sample, a plausible CV, no warning, 6 answers
// where there should be 12. Reported from a real bench 2026-07-16.
//
// WHY THIS TAKES A `replicates` ARGUMENT INSTEAD OF DETECTING THE SPLIT. The two
// blocks are ADJACENT — row A's sample wells are columns 4,5,6,7,8,9, one
// unbroken run. Nothing in the data distinguishes "two 3-replicate samples" from
// "one 6-replicate sample": both are six tagged wells in a row. A gap-detector
// would be right only for plates that happen to leave a spare column, and wrong
// silently for the rest. So the app is TOLD the replicate count. Guessing here
// would be guessing quietly, which is the one thing this project forbids.
//
// WHY ONLY SAMPLES NEED THIS, and the ladder does not: standards carry their
// identity in a NUMBER the user types (the concentration), and compute.js groups
// them by it — so two ladder blocks at the same concentrations correctly merge
// into more replicates. Samples carry their identity in a NAME keyed to position.
// Identity-by-value merges harmlessly; identity-by-position does not.
// ============================================================

/**
 * Split the sample wells into groups, one per sample.
 *
 * @param wells       All well objects.
 * @param replicates  Wells per sample (>= 1).
 * @returns [{ key, row, block, wells }] — `wells` sorted left to right, `key` is
 *          stable across re-tagging so a name the user typed survives.
 *
 * Ordered BLOCK-MAJOR, then by row: down the first block of columns, then down
 * the next. That is the order a plate gets filled, so prefilled S1…S12 land
 * where a human expects them (S1-S8 down block one, S9-S12 down block two).
 */
export function sampleBlocks(wells, replicates = DEFAULT_REPLICATES) {
  const n = Math.max(1, Math.floor(replicates) || 1);

  const byRow = new Map();
  for (const w of wells) {
    if (w.role !== "sample") continue;
    if (!byRow.has(w.row)) byRow.set(w.row, []);
    byRow.get(w.row).push(w);
  }

  const groups = [];
  for (const [row, rowWells] of byRow) {
    rowWells.sort((a, b) => a.col - b.col);
    for (let i = 0; i < rowWells.length; i += n) {
      const block = Math.floor(i / n);
      groups.push({ key: `${row}:${block}`, row, block, wells: rowWells.slice(i, i + n) });
    }
  }
  groups.sort((a, b) => a.block - b.block || a.row - b.row);
  return groups;
}

// Well name from zero-based row/col, e.g. (0,0) -> "A1".
export function wellName(row, col) {
  return String.fromCharCode(65 + row) + (col + 1);
}

export function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Fill in all 96 well centers by bilinear interpolation between the 4 corners.
// corners order: 0=TL(A1), 1=TR(A12), 2=BL(H1), 3=BR(H12)
//
// Returns { wells, wellRadius } rather than mutating a global. Callers own their
// own state; the geometry is just arithmetic.
export function buildGrid(corners) {
  const [TL, TR, BL, BR] = corners;
  const wells = [];
  for (let r = 0; r < ROWS; r++) {
    const v = ROWS === 1 ? 0 : r / (ROWS - 1);
    for (let c = 0; c < COLS; c++) {
      const u = COLS === 1 ? 0 : c / (COLS - 1);
      const top = lerp(TL, TR, u);
      const bottom = lerp(BL, BR, u);
      const center = lerp(top, bottom, v);
      wells.push({
        row: r,
        col: c,
        name: wellName(r, c),
        x: center.x,
        y: center.y,
        role: "unused",
        conc: null,
        label: "",
        color: null,
      });
    }
  }
  // Sampling radius = ~30% of the spacing between adjacent wells in a row.
  const spacing = Math.hypot(wells[1].x - wells[0].x, wells[1].y - wells[0].y);
  const wellRadius = Math.max(4, spacing * 0.3);
  return { wells, wellRadius };
}

// ============================================================
// SBS standard geometry — for the locked corners-of-the-PLATE redesign.
//
// An SBS 96-well plate is 127.76 x 85.48mm with a 9mm square well pitch, and
// A1's center sits 14.38mm from the left edge and 11.24mm from the top. So every
// well is a fixed fraction of the plate rectangle and 96 wells fall out of the
// 4 plate corners with no measurement at all.
//
// READ THIS BEFORE USING IT (CONTEXT.md, 2026-07-15): these fractions are exact,
// but they do NOT survive contact with a real photo on their own. The plate is
// ~14mm tall, so well centers sit on the plate's TOP surface while the outline
// you would click is the BOTTOM of the skirt. At a ~20-25cm phone distance that
// height difference alone is a ~6% scale gap — enough to sample the wrong wells
// at the plate's edges while looking fine in the middle. Wrong-but-plausible
// numbers, no warning.
//
// So corners give position, rotation, and a starting scale. They must be
// followed by a confirm-and-nudge step before the grid counts. Do not wire these
// straight into a final answer.
// ============================================================

export const SBS = {
  plateWidthMm: 127.76,
  plateHeightMm: 85.48,
  wellPitchMm: 9,
  a1CenterXMm: 14.38,
  a1CenterYMm: 11.24,
};

// Fractional position of a well center within the plate rectangle (0..1).
export function wellFraction(row, col) {
  return {
    u: (SBS.a1CenterXMm + SBS.wellPitchMm * col) / SBS.plateWidthMm,
    v: (SBS.a1CenterYMm + SBS.wellPitchMm * row) / SBS.plateHeightMm,
  };
}
