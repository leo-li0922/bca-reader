// ============================================================
// Plate geometry. Pure; no DOM.
// ============================================================

// Standard 96-well = 8 rows (A-H) x 12 cols (1-12).
export const ROWS = 8;
export const COLS = 12;

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
