// ============================================================
// Pasted spreadsheet text → a plate block of readings.
//
// The second way a signal gets into this app. The photo path samples pixels; this
// path takes the numbers the plate reader already measured. Both end at the same
// place — a well carrying a `signal` — which is why nothing downstream of here
// (the fit, the stats, the thresholds, Step 7, Step 8) needs to know which one
// happened. See CONTEXT.md → "the OD path".
//
// Pure; no DOM. Parsing text is not an edge concern the way pixels are: there is
// no canvas and no clipboard in here, just a string in and numbers out, so the
// harness can import this exactly like it imports the fit. (ADR 0001.)
//
// WHY PASTE AND NOT A FILE. A real instrument workbook is not just the grid — the
// plate-3124 sheet carries the raw export, a hand-built analysis block, and a
// chart, all on one sheet. Reading a file means guessing which rectangle is the
// plate, and a wrong guess is silent: you get a confident loading plan built on
// the BSA column. A paste has no guess in it, because the SELECTION is the answer.
// The user points at the data. That is the whole argument, and it is why this
// module takes a string rather than bytes.
//
// WHAT WE STILL HAVE TO GUESS, AND THE RULE FOR IT. Even a selection can carry a
// header row or a label column along for the ride. We strip those, but every strip
// is REPORTED back in `notes` and rendered before anything computes. The rule this
// module follows: guessing is allowed, guessing quietly is not.
// ============================================================

import { ROWS, COLS } from "./plate.js";

// An OD read below this is not a well that was measured — it is an empty cell the
// instrument never filled. Kept distinct from a legitimate 0.0 reading, which
// cannot happen on a real BCA plate (even a blank absorbs ~0.07).
export const EMPTY_CELL = null;

// A first row of small ascending integers is a column header (1, 2, 3 …), not
// data. Real ODs are never a consecutive integer run.
function looksLikeHeaderRow(cells) {
  const nums = cells.filter((c) => c !== "").map(Number).filter((n) => isFinite(n));
  if (nums.length < 2) return false;
  if (!nums.every((n) => Number.isInteger(n) && n >= 1 && n <= COLS)) return false;
  for (let i = 1; i < nums.length; i++) if (nums[i] <= nums[i - 1]) return false;
  return true;
}

// A first column is a label column if it names rows ("A", "B", …) or is mostly
// empty. The plate-3124 export's `Temperature(°C)` column is the second case: one
// value in the top cell, then nothing.
function looksLikeLabelColumn(cells) {
  const nonEmpty = cells.filter((c) => c !== "");
  if (!nonEmpty.length) return true;
  if (nonEmpty.every((c) => !isFinite(Number(c)))) return true;
  return nonEmpty.length <= cells.length / 2;
}

function splitRows(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // Tabs are what a spreadsheet actually puts on the clipboard. Comma and
  // run-of-spaces are fallbacks for a .csv or a plain-text instrument dump.
  const sep = text.includes("\t") ? "\t" : text.includes(",") ? "," : /\s{2,}| +/;
  return lines.map((l) => l.split(sep).map((c) => c.trim()));
}

// Drop rows/columns that are entirely empty, from the edges inward. A selection
// that overshoots by a row costs nothing this way.
function trimEmptyEdges(m) {
  while (m.length && m[0].every((c) => c === "")) m.shift();
  while (m.length && m[m.length - 1].every((c) => c === "")) m.pop();
  if (!m.length) return m;
  const width = Math.max(...m.map((r) => r.length));
  for (const r of m) while (r.length < width) r.push("");
  while (m[0].length && m.every((r) => r[0] === "")) for (const r of m) r.shift();
  while (m[0].length && m.every((r) => r[r.length - 1] === "")) for (const r of m) r.pop();
  return m;
}

/**
 * Parse pasted spreadsheet text into a rectangular block of plate readings.
 *
 * @param text  Whatever came off the clipboard.
 * @returns { ok: true, grid, nRows, nCols, nRead, notes }
 *          | { ok: false, error }
 *
 * `grid` is nRows x nCols of `number | null`. null = a cell with no reading, which
 * is a real thing on a real plate (plate-3124's row F columns 4-6 are empty wells
 * the instrument never read) and must NOT be confused with a reading of 0.
 */
export function parsePlateBlock(text) {
  if (!text || !text.trim()) {
    return { ok: false, error: "Nothing pasted. Copy the block of readings out of your spreadsheet first." };
  }

  let m = trimEmptyEdges(splitRows(text));
  if (!m.length) return { ok: false, error: "Nothing pasted but empty cells." };

  const notes = [];

  // Strip a header row / label column, loudly.
  if (m.length > 1 && looksLikeHeaderRow(m[0])) {
    m.shift();
    notes.push("Dropped a column-number header row.");
  }
  if (m.length && m[0].length > 1 && looksLikeLabelColumn(m.map((r) => r[0]))) {
    for (const r of m) r.shift();
    notes.push("Dropped a row-label / temperature column.");
  }
  m = trimEmptyEdges(m);
  if (!m.length || !m[0].length) {
    return { ok: false, error: "No readings left after dropping headers. Select just the cells holding OD values." };
  }

  const nRows = m.length;
  const nCols = m[0].length;

  if (nRows > ROWS || nCols > COLS) {
    return {
      ok: false,
      error: `That block is ${nRows} x ${nCols}. A 96-well plate is ${ROWS} rows x ${COLS} columns — select a smaller range.`,
    };
  }

  // Cells → numbers. A cell that is not a number is an unread well, not an error:
  // instruments leave gaps. But we count them, so "I pasted the wrong thing"
  // still surfaces as an implausible read count rather than a silent empty plate.
  const grid = [];
  let nRead = 0;
  const bad = [];
  for (let r = 0; r < nRows; r++) {
    const row = [];
    for (let c = 0; c < nCols; c++) {
      const raw = (m[r][c] ?? "").trim();
      if (raw === "") { row.push(EMPTY_CELL); continue; }
      const v = Number(raw);
      if (!isFinite(v)) { row.push(EMPTY_CELL); bad.push(raw); continue; }
      row.push(v);
      nRead++;
    }
    grid.push(row);
  }

  if (nRead < 2) {
    return { ok: false, error: "Found fewer than 2 readings in that block. Select the cells holding the OD values." };
  }
  if (bad.length) {
    const shown = [...new Set(bad)].slice(0, 3).map((b) => `"${b}"`).join(", ");
    notes.push(`Ignored ${bad.length} cell(s) that are not numbers (${shown}) — treated as empty wells.`);
  }

  notes.push(`Read a ${nRows} x ${nCols} block: ${nRead} well(s) with a value.`);
  return { ok: true, grid, nRows, nCols, nRead, notes };
}

/**
 * Lay a parsed block onto the plate, starting at well A1.
 *
 * @param wells  All ROWS*COLS well objects (from buildGrid).
 * @param grid   From parsePlateBlock().
 *
 * Sets `signal` (and `reading`, kept for display) on every well the block covers
 * that has a value. Wells outside the block, and cells with no value, are left
 * `unused` with no signal — so a 8x6 paste occupies the left half of the plate and
 * the rest stays untaggable, which is exactly what the user's plate looked like.
 *
 * Why A1 and not an origin the user picks: an instrument export starts at A1
 * because the instrument reads from A1. Offsetting is a guess, and the confirm
 * step renders the block in place, so a misplaced block is visible rather than
 * argued about. If a real run ever needs an offset, add it there — not here.
 */
export function applyBlockToWells(wells, grid) {
  let placed = 0;
  for (const w of wells) {
    const v = grid[w.row]?.[w.col];
    if (v === undefined || v === EMPTY_CELL) continue;
    w.reading = v;
    w.signal = v;
    w.color = null; // the signal did not come from pixels; say so explicitly
    placed++;
  }
  return placed;
}
