// ============================================================
// BCA Reader — the DESKTOP EDGE.
//
// This file renders and collects input. It does NOT do science. Every fit,
// threshold, statistic, and plate constant lives in ../core/, which knows
// nothing about a DOM and is shared with the offline validation harness (and,
// later, any other front-end). See docs/adr/0001-extract-math-core.md.
//
// If you are about to add a number here that the math cares about — a
// threshold, a cutoff, a constant — it belongs in core/, not in this file.
//
// Pipeline:
//   1. Load a plate photo (or a synthetic demo plate).
//   2. User clicks 4 corner wells; we interpolate all 96 centers.
//   3. User tags wells as blank / standard / sample.
//   4. Sample each well's pixels, hand the tagged wells to the core, render
//      whatever it returns.
// ============================================================

import {
  ROWS,
  COLS,
  buildGrid as buildGridGeometry,
  sampleColorAt,
  computeConcentrations as coreCompute,
  planLoading as corePlan,
  parsePlateBlock,
  applyBlockToWells,
  sampleBlocks,
  DEFAULT_REPLICATES,
  LOADING_DEFAULTS,
  DILUTION_NOTE,
  DEFAULT_FIT,
} from "../core/index.js";

// ---- Application state ----
const state = {
  // WHERE THE SIGNAL CAME FROM: "photo" | "od" | null.
  //
  // The photo path samples pixels off a canvas; the OD path pastes numbers a
  // plate reader already measured. This flag exists ONLY for the edge — what to
  // draw, what to call things, whether Step 2 marks corners. The core never sees
  // it and must never need to: both paths hand it a well carrying a `signal`,
  // and that is the entire seam (ADR 0001, core/import.js).
  source: null,
  baseImageData: null, // clean pixel array of the loaded image (for sampling)
  naturalW: 0,
  naturalH: 0,
  odGrid: null,        // the parsed block, OD path only (rows x cols of num|null)
  odRange: null,       // { min, max } across the block, for shading
  corners: [],         // up to 4 {x, y} in image pixel coords: TL, TR, BL, BR
  wells: [],           // 96 well objects once the grid is built
  mode: "idle",        // 'idle' | 'corners' | 'review' | 'blanks' | 'standards' | 'samples'
  brush: { role: "blank", conc: 0, label: "S1" },
  wellRadius: 8,       // sampling radius in pixels, derived from spacing
  // The ladder is defined per PLATE ROW: row index -> concentration. Every well
  // in the row shares it, i.e. same row = replicates.
  rowConc: {},
  // Samples are defined per BLOCK OF REPLICATES, keyed "row:block" — because a
  // row holds more than one sample once a plate needs a second block of columns
  // (12 samples = cols 4-6 rows A-H, then cols 7-9 rows A-D). Keyed by row alone,
  // those two silently merged into one 6-well "sample". See core/plate.js.
  rowLabel: {},
  // Wells per sample, side by side. The blocks are adjacent, so this cannot be
  // detected from the data — it has to be told. core/plate.js explains why.
  replicates: DEFAULT_REPLICATES,
  // Set when a step is opened via Review's Edit, so finishing that step returns
  // to Review instead of walking the rest of the chain.
  returnTo: null,
  // Step 7's sample reads, kept so Step 8 can re-plan when a protocol field
  // changes without re-sampling every pixel. Null until the first compute.
  sampleResults: null,
  // The last loading plan the core returned. Read by the collapsed-card summary
  // and the CSV export. Null until Step 8 is opened.
  plan: null,
  // The curve the last compute produced. Read only by Step 7's CSV, so an
  // exported file can say which fit made its numbers. Null until the first read.
  fit: null,
};

// ---- DOM shortcuts ----
const $ = (id) => document.getElementById(id);
const canvas = $("plateCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

// ============================================================
// Image loading
// ============================================================

// Show what happened after a file pick. Without this the only confirmation a
// user gets is the photo appearing, so a failed decode looks identical to a
// misclick. `kind` is "ok" or "error".
function setFileStatus(message, kind) {
  const el = $("fileStatus");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("status-error", kind === "error");
  el.hidden = !message;
}

// Read one file (from the picker OR a drag-drop) and draw it onto the canvas.
function ingestFile(file) {
  if (!file) return;

  // HEIC is what an iPhone writes by default, and no Chromium browser can
  // decode it. Catch it by name before the decoder fails, so the user gets a
  // real instruction instead of a generic "couldn't read that".
  if (/\.(heic|heif)$/i.test(file.name)) {
    setFileStatus(
      `Can't read ${file.name}. This browser cannot decode HEIC (iPhone's default photo format). Export or convert it to JPEG or PNG and pick that instead.`,
      "error"
    );
    return;
  }

  setFileStatus(`Loading ${file.name}...`, "ok");
  const reader = new FileReader();
  reader.onload = (ev) => loadImageFromURL(ev.target.result, file.name);
  reader.onerror = () =>
    setFileStatus(`Could not read ${file.name} off disk.`, "error");
  reader.readAsDataURL(file);
}

// The file picker (the dropzone is a <label> wrapping this input).
$("fileInput").addEventListener("change", (e) => ingestFile(e.target.files[0]));

// Drag-and-drop onto the dropzone. dragover must preventDefault or the browser
// just opens the dropped file in a new tab instead of handing it to us.
const dropzone = $("dropzone");
if (dropzone) {
  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-drag");
    })
  );
  ["dragleave", "dragend", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-drag");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) ingestFile(file);
  });
}

// Draw an image (from any URL/dataURL) onto the canvas and cache its pixels.
// `name` is optional and only used for the on-screen confirmation line.
function loadImageFromURL(url, name) {
  const img = new Image();
  // A decode failure used to do nothing at all: onload simply never fired and
  // the app sat there looking like the click was ignored. Never fail silently.
  img.onerror = () => {
    setFileStatus(
      name
        ? `Could not decode ${name}. The file may be corrupt or in a format this browser does not support.`
        : "Could not decode that image.",
      "error"
    );
  };
  img.onload = () => {
    state.naturalW = img.naturalWidth;
    state.naturalH = img.naturalHeight;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
    // Cache a clean copy of the pixels so overlay drawing never corrupts sampling.
    state.baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Reset downstream state for a fresh image.
    //
    // `source` MUST be reset here. Loading a photo after pasting an OD block is
    // one click away (the tabs sit side by side), and leaving source="od" meant
    // redraw() painted an empty OD grid over the photo and computeConcentrations()
    // skipped pixel sampling entirely — a broken app, silently. The rule: whatever
    // puts a plate into state OWNS declaring where its signal comes from.
    // ingestPasteText() claims "od"; this claims "photo". Neither may assume.
    state.source = "photo";
    state.odGrid = null;
    state.odRange = null;
    state.corners = [];
    state.wells = [];
    state.wellRadius = 8; // drop the OD path's cell-sized hit radius
    state.rowConc = {};
    state.rowLabel = {};
    state.sampleResults = null;
    state.plan = null;
    state.fit = null;
    state.mode = "corners";
    // Start the tagging wizard at the CORNERS phase (canvas is in the grid slot,
    // ready to click). Don't scroll to the grid step here — we scroll to the
    // collapsed Load step below instead, so its green check sits at the top.
    revealGridStep();
    enterPhase("corners", { flash: false, scroll: false });
    // Step 1 is done: collapse it to a green check + filename, and snap so that
    // confirmation is the first thing you see, with Confirm the grid below it.
    const nameEl = $("loadedName");
    if (nameEl) nameEl.textContent = name || "plate photo";
    if (name) setFileStatus(`Loaded ${name} (${img.naturalWidth}x${img.naturalHeight})`, "ok");
    collapseStep("loadCard");
    scrollStepToTop($("loadCard"));
  };
  img.src = url;
}

// ============================================================
// The OD path: pasted plate reader readings -> a tagged plate
//
// Everything here is EDGE work: read a textarea, invent a canvas to draw on,
// paint cells. The parsing and the placement are the core's (core/import.js),
// because they are arithmetic on a string and the harness deserves them too.
//
// The payoff of this path is that Step 2 has nothing to do. Corner marking exists
// to solve parallax — pixels arrive in an unknown position, so you mark 4 corners
// and interpolate 96 centers, and CONTEXT.md is emphatic that a misaligned grid is
// the #1 cause of a wrong read. A pasted grid has no geometry to get wrong: row 3
// column 4 IS well C4. So this path cannot produce the project's worst failure
// mode, which is most of why it is worth having.
// ============================================================

// Cell geometry for the synthetic OD plate, in canvas px. Sized so a 12-column
// plate is legible without scrolling on a laptop and an OD like 0.0701 fits.
const OD_CELL_W = 94;
const OD_CELL_H = 76;
const OD_MARGIN_L = 52; // gutter for the row letters A–H
const OD_MARGIN_T = 44; // gutter for the column numbers 1–12
const OD_PAD = 20;

// An OD cell's fill: light → BCA purple, scaled to the block's OWN range rather
// than an absolute OD, so a faint plate still shows its ladder as a gradient.
// This is presentation only — nothing downstream reads these pixels (contrast the
// photo path, where the pixels ARE the data).
function odCellColor(t) {
  const k = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(246 - k * 90),
    g: Math.round(244 - k * 160),
    b: Math.round(250 - k * 40),
  };
}

// A well can only be tagged if it actually holds a reading. On the photo path
// every well has pixels, so everything is taggable. On the OD path a pasted 8x6
// block leaves half the plate with no reading at all, and tagging one of those
// would hand the core a well it must reject. Cheaper to not allow the click.
function isTaggable(w) {
  return state.source !== "od" || isFinite(w.reading);
}

function setPasteStatus(message, kind) {
  const el = $("pasteStatus");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
  el.classList.toggle("is-error", kind === "error");
  el.classList.toggle("is-ok", kind === "ok");
}

// Read whatever is in the paste box, lay it on the plate, and open Step 2.
function ingestPasteText(text) {
  const parsed = parsePlateBlock(text);
  if (!parsed.ok) {
    setPasteStatus(parsed.error, "error");
    return;
  }

  // Invent a canvas for the plate to live on. The photo path gets its dimensions
  // from the image; here we choose them, which is the only real difference.
  canvas.width = OD_MARGIN_L + COLS * OD_CELL_W + OD_PAD;
  canvas.height = OD_MARGIN_T + ROWS * OD_CELL_H + OD_PAD;
  state.naturalW = canvas.width;
  state.naturalH = canvas.height;
  state.baseImageData = null; // there are no source pixels on this path, by design

  // Reuse the core's geometry rather than inventing a second way to place wells:
  // hand buildGrid the four CELL CENTRES it would have interpolated from, and it
  // produces the same well objects the photo path uses. Same hit-testing, same
  // box-select, same everything downstream.
  const cx = (c) => OD_MARGIN_L + (c + 0.5) * OD_CELL_W;
  const cy = (r) => OD_MARGIN_T + (r + 0.5) * OD_CELL_H;
  const { wells } = buildGridGeometry([
    { x: cx(0), y: cy(0) },
    { x: cx(COLS - 1), y: cy(0) },
    { x: cx(0), y: cy(ROWS - 1) },
    { x: cx(COLS - 1), y: cy(ROWS - 1) },
  ]);
  state.wells = wells;
  // Not the core's 0.3-of-spacing sampling radius: nothing is being sampled here.
  // This radius is purely a hit target, so it wants to fill the cell.
  state.wellRadius = Math.min(OD_CELL_W, OD_CELL_H) * 0.5;

  const placed = applyBlockToWells(state.wells, parsed.grid);

  const vals = state.wells.filter((w) => isFinite(w.reading)).map((w) => w.reading);
  state.odGrid = parsed.grid;
  state.odRange = { min: Math.min(...vals), max: Math.max(...vals) };
  state.source = "od";
  state.corners = [];
  state.rowConc = {};
  state.rowLabel = {};
  state.sampleResults = null;
  state.plan = null;
    state.fit = null;

  // Straight to the confirm view — there are no corners to mark. This is the step
  // the photo path spends its whole Step 2 earning.
  revealGridStep();
  enterPhase("review", { flash: false, scroll: false });

  const nameEl = $("loadedName");
  if (nameEl) nameEl.textContent = `plate reader data · ${parsed.nRows}x${parsed.nCols}`;
  setPasteStatus(parsed.notes.join(" "), "ok");
  collapseStep("loadCard");
  scrollStepToTop($("loadCard"));
  return placed;
}

// ---- Step 1's source tabs ----
function selectSource(which) {
  const photo = which === "photo";
  $("tabPhoto").classList.toggle("is-active", photo);
  $("tabPaste").classList.toggle("is-active", !photo);
  $("tabPhoto").setAttribute("aria-selected", String(photo));
  $("tabPaste").setAttribute("aria-selected", String(!photo));
  $("panelPhoto").hidden = !photo;
  $("panelPaste").hidden = photo;
}
$("tabPhoto").addEventListener("click", () => selectSource("photo"));
$("tabPaste").addEventListener("click", () => selectSource("paste"));

$("pasteBtn").addEventListener("click", (e) => {
  e.preventDefault();
  ingestPasteText($("pasteBox").value);
});
$("pasteClearBtn").addEventListener("click", (e) => {
  e.preventDefault();
  $("pasteBox").value = "";
  setPasteStatus("", "ok");
});
// Pasting into the box is the whole gesture — don't also make them hit a button.
// Deferred a tick so the textarea holds the pasted text by the time we read it.
$("pasteBox").addEventListener("paste", () => {
  setTimeout(() => {
    const v = $("pasteBox").value;
    if (v.trim()) ingestPasteText(v);
  }, 0);
});

// ============================================================
// Corner marking -> build the full 96-well grid
// ============================================================

// ============================================================
// The tagging wizard: steps 2–5
//
// Each step is its own card. There is ONE plate canvas; enterPhase() MOVES it
// into the active step's .stage slot, so the plate is integrated into every step
// without duplicating it. Finished steps collapse to a green-check confirmation;
// the active step is scrolled to a consistent spot so the plate stays put on
// screen. Flow: corners -> review (both the grid card) -> blanks -> standards ->
// samples, then compute -> results.
// ============================================================

const PHASE_SLOT = {
  corners: "gridSlot", review: "gridSlot",
  blanks: "blanksSlot", standards: "ladderSlot", samples: "samplesSlot",
  check: "reviewSlot",
};
const PHASE_CARD = {
  corners: "gridCard", review: "gridCard",
  blanks: "blanksCard", standards: "ladderCard", samples: "samplesCard",
  check: "reviewCard",
};
const WIZARD_CARDS = ["gridCard", "blanksCard", "ladderCard", "samplesCard", "reviewCard"];

function revealGridStep() { $("resultsCard").hidden = true; }
function scrollStepToTop(card) {
  if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
}
function collapseStep(cardId) { const c = $(cardId); if (c) c.classList.add("is-done"); }
function expandStep(cardId) { const c = $(cardId); if (c) c.classList.remove("is-done"); }

// The X on the collapsed Load step: wipe the image + everything derived from it
// and return to Step 1, ready for a different photo.
const clearPhotoBtn = $("clearPhotoBtn");
if (clearPhotoBtn) {
  clearPhotoBtn.addEventListener("click", (e) => {
    e.preventDefault();
    state.baseImageData = null;
    state.corners = [];
    state.wells = [];
    state.rowConc = {};
    state.rowLabel = {};
    state.sampleResults = null;
    state.plan = null;
    state.fit = null;
    state.mode = "idle";
    // Reset the OD path too, or the next photo loads onto a canvas that still
    // thinks it is a spreadsheet.
    state.source = null;
    state.odGrid = null;
    state.odRange = null;
    const pb = $("pasteBox");
    if (pb) pb.value = "";
    setPasteStatus("", "ok");
    const fi = $("fileInput");
    if (fi) fi.value = "";                 // let the same file be re-picked
    setFileStatus("", "ok");
    expandStep("loadCard");
    WIZARD_CARDS.forEach((id) => { const c = $(id); if (c) { c.hidden = true; c.classList.remove("is-done"); } });
    $("resultsCard").hidden = true;
    $("loadingCard").hidden = true;
    scrollStepToTop($("loadCard"));
  });
}

// Step 2's verdict banner. Steps 3–5 carry static instruction text in the HTML.
// The corners phase is driven live by updateCornerStatus().
function setVerdict(kind) {
  const v = $("gridVerdict");
  if (!v) return;
  v.classList.remove("is-setup", "is-found", "is-adjusted");
  if (kind === "placed") {
    const cs = $("cornerStatus");
    if (cs) cs.hidden = true;
    v.classList.add("is-found");
    if (state.source === "od") {
      // Nothing to align — the ask here is "did your block land where you meant",
      // which is a different question from the photo path's "do the circles sit
      // on the wells". Same step, different doubt.
      const n = state.wells.filter((w) => isFinite(w.reading)).length;
      v.innerHTML =
        `<span class="flag flag-ok"><i></i>Readings placed</span>` +
        `<span class="verdict-text">${n} well(s) filled in, starting at A1. Check the numbers sit where they did on your plate — your ladder should read as a gradient. Then hit Looks right.</span>`;
    } else {
      v.innerHTML =
        `<span class="flag flag-ok"><i></i>Grid placed</span>` +
        `<span class="verdict-text">Every well shows its name. Check the circles line up, then hit Looks right.</span>`;
    }
  }
}

// Phases where clicking a well tags it.
function isTagPhase() {
  return state.mode === "blanks" || state.mode === "standards" || state.mode === "samples";
}

// Each tagging step's banner reports that step's OWN state: amber while nothing
// is tagged for it, green once something is. Recomputed whenever you enter the
// step and after every tag change, so it can never go stale as you move back and
// forth (a step whose tags were cleared by Back goes amber again).
const PHASE_VERDICT = {
  blanks: {
    el: "blanksVerdict",
    role: "blank",
    state: (wells) => wells.length
      ? { ok: true,
          flag: `${wells.length} blank${wells.length === 1 ? "" : "s"}`,
          text: "Click a well to add or remove it. Drag a box to tag several at once." }
      : { ok: false,
          flag: "No blanks yet",
          text: "Click every blank (zero-protein) well — these set the baseline." },
  },
  standards: {
    el: "ladderVerdict",
    role: "standard",
    state: (wells) => {
      if (!wells.length) {
        return { ok: false, flag: "No ladder yet",
          text: "Drag a box around all the ladder wells, then give each row its concentration." };
      }
      const rows = [...new Set(wells.map((w) => w.row))];
      const missing = rows.filter((r) => state.rowConc[r] == null || isNaN(state.rowConc[r]));
      if (missing.length) {
        return { ok: false,
          flag: `${missing.length} row${missing.length === 1 ? "" : "s"} need a concentration`,
          text: "Fill in each row's concentration below the plate. Wells sharing a row are treated as replicates." };
      }
      return { ok: true,
        flag: `${rows.length} rung${rows.length === 1 ? "" : "s"} · ${wells.length} wells`,
        text: "Each row is one rung of the ladder; the wells across it are replicates." };
    },
  },
  samples: {
    el: "samplesVerdict",
    role: "sample",
    state: (wells) => {
      if (!wells.length) {
        return { ok: false, flag: "No samples yet",
          text: "Drag a box around all the sample wells, then name each group." };
      }
      // Keyed by GROUP, not row. Keyed by row this went permanently green on a
      // two-block plate — it read rowLabel[0] while the real keys were "0:0" and
      // "0:1" — so the gate waved through samples that had no name at all.
      const groups = sampleBlocks(state.wells, state.replicates);
      const missing = groups.filter((g) => {
        const l = state.rowLabel[g.key];
        return !l || !String(l).trim();
      });
      if (missing.length) {
        return { ok: false,
          flag: `${missing.length} sample${missing.length === 1 ? "" : "s"} need a name`,
          text: "Name each group below the plate. Wells side by side within a group are treated as replicates." };
      }
      // Two groups sharing a name get pooled into ONE sample by the core. Say so
      // here rather than let it happen quietly — but do not block: pooling can be
      // deliberate. Amber, never red.
      const names = groups.map((g) => String(state.rowLabel[g.key]).trim());
      const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      if (dupes.length) {
        return { ok: true, warn: true,
          flag: `${dupes.length} duplicate name${dupes.length === 1 ? "" : "s"}`,
          text: `${dupes.map((d) => `“${d}”`).join(", ")} ${dupes.length === 1 ? "is" : "are"} used more than once — those wells will be pooled into one sample. Rename them if they are different samples.` };
      }
      return { ok: true,
        flag: `${groups.length} sample${groups.length === 1 ? "" : "s"} · ${wells.length} wells`,
        text: groups.some((g) => g.block > 0)
          ? "Each group is one unknown; the wells across it are replicates."
          : "Each row is one unknown; the wells across it are replicates." };
    },
  },
};

// A step's forward button is disabled until the step is actually finished, so a
// half-done step can never be walked past. `reason` becomes the tooltip.
// The "Re-mark corners" escape hatch only makes sense once a corner exists.
function updateResetBtn() {
  const b = $("resetCornersBtn");
  // The OD path has no corners to re-mark, so the escape hatch would be a button
  // that wipes the plate and drops you into a corner-marking phase with no image.
  if (b) b.hidden = state.source === "od" || state.corners.length === 0;
}

function setStepGate(cardId, ok, reason) {
  const card = $(cardId);
  if (!card) return;
  const next = card.querySelector(".btn[data-nav]:not(.btn-secondary)");
  if (!next) return;
  next.disabled = !ok;
  next.title = ok ? "" : `Finish this step first — ${reason}`;
}

function updatePhaseVerdict(mode = state.mode) {
  const cfg = PHASE_VERDICT[mode];
  if (!cfg) return;
  const v = $(cfg.el);
  if (!v) return;
  const wells = state.wells.filter((w) => w.role === cfg.role);
  const s = cfg.state(wells);
  v.classList.remove("is-setup", "is-found");
  v.classList.add(s.ok && !s.warn ? "is-found" : "is-setup");
  // `warn` = finished, but something here deserves a human. The step still lets
  // you past (s.ok gates that); the flag just refuses to look reassuring.
  v.innerHTML =
    `<span class="flag ${s.ok && !s.warn ? "flag-ok" : "flag-caution"}"><i></i>${s.flag}</span>` +
    `<span class="verdict-text">${s.text}</span>`;
  setStepGate(PHASE_CARD[mode], s.ok, s.flag);
}

// Fill a collapsed card's one-line summary from what has been tagged so far.
function setCardSummary(id) {
  const put = (elId, text) => { const el = $(elId); if (el) el.textContent = text; };
  if (id === "gridCard") {
    // "96 wells placed" is a lie on the OD path, where a pasted 8x6 block fills 48.
    put(
      "gridSummaryText",
      state.source === "od"
        ? `${state.wells.filter((w) => isFinite(w.reading)).length} readings placed`
        : "96 wells placed"
    );
  } else if (id === "blanksCard") {
    const n = state.wells.filter((w) => w.role === "blank").length;
    put("blanksSummaryText", `${n} blank${n === 1 ? "" : "s"}`);
  } else if (id === "ladderCard") {
    const stds = state.wells.filter((w) => w.role === "standard");
    const rungs = new Set(stds.map((w) => w.conc)).size;
    put("ladderSummaryText", `${stds.length} well${stds.length === 1 ? "" : "s"} · ${rungs} rung${rungs === 1 ? "" : "s"}`);
  } else if (id === "samplesCard") {
    const labels = new Set(state.wells.filter((w) => w.role === "sample").map((w) => w.label || w.name)).size;
    put("samplesSummaryText", `${labels} sample${labels === 1 ? "" : "s"}`);
  } else if (id === "reviewCard") {
    const n = state.wells.filter((w) => w.role !== "unused").length;
    put("reviewSummaryText", `${n} well${n === 1 ? "" : "s"} tagged`);
  } else if (id === "loadingCard") {
    // Step 8 summarises the protocol, not the plate: µg per lane is the one
    // number you would want to see at a glance on a collapsed card.
    const p = state.plan;
    put(
      "loadingSummaryText",
      p && p.ok ? `${p.shared.massPerLane.toFixed(1)} µg per lane` : "—"
    );
  }
}

// A subtle pulse on a card + its badge whenever it becomes the active step.
function flashPhase(card) {
  if (!card) return;
  card.classList.remove("phase-flash");
  void card.offsetWidth;
  card.classList.add("phase-flash");
}

// Enter a phase: move the plate into this step's card, collapse the steps before
// it, hide the steps after it, set the brush, then flash + scroll so the plate
// lands in the same on-screen spot every step.
function enterPhase(mode, opts = {}) {
  state.mode = mode;
  const activeCard = PHASE_CARD[mode];
  const activeIdx = WIZARD_CARDS.indexOf(activeCard);

  // Move the single plate canvas into this step's slot.
  const slot = $(PHASE_SLOT[mode]);
  if (slot && canvas.parentElement !== slot) slot.appendChild(canvas);

  // Steps before the active one collapse to a confirmation; the active one is
  // expanded; later ones are hidden until reached.
  WIZARD_CARDS.forEach((id, i) => {
    const card = $(id);
    if (!card) return;
    if (i < activeIdx) { card.hidden = false; card.classList.add("is-done"); setCardSummary(id); }
    else if (i === activeIdx) { card.hidden = false; card.classList.remove("is-done"); }
    else { card.hidden = true; card.classList.remove("is-done"); }
  });

  const cg = $("confirmGridBtn");
  if (mode === "corners") {
    if (cg) cg.hidden = true;
    updateCornerStatus();
  } else if (mode === "review") {
    if (cg) cg.hidden = false;
    setVerdict("placed");
  } else if (mode === "blanks") {
    state.brush.role = "blank";
    updatePhaseVerdict(mode);
  } else if (mode === "standards") {
    state.brush.role = "standard";
    renderLadderRows();
    updatePhaseVerdict(mode);
  } else if (mode === "samples") {
    state.brush.role = "sample";
    renderSampleRows();
    updatePhaseVerdict(mode);
  } else if (mode === "check") {
    renderReviewParts();
    updateReviewVerdict();
  }
  // Any results on screen are stale the moment we step back into the wizard.
  $("resultsCard").hidden = true;

  updateResetBtn();
  const activeEl = $(activeCard);
  if (opts.flash !== false) flashPhase(activeEl);
  // On a forward move ("Looks right"), snap so the JUST-finished step's green
  // check sits at the top of the page, with the new active step right below it.
  // Otherwise snap to the active step itself.
  if (opts.scroll !== false) {
    const target = opts.scrollTo === "prev" && activeIdx > 0
      ? $(WIZARD_CARDS[activeIdx - 1])
      : activeEl;
    scrollStepToTop(target);
  }
  redraw();
}

// Clear whatever was tagged in a given tagging phase (used when you go Back).
function clearPhaseTags(mode) {
  const roleOf = { blanks: "blank", standards: "standard", samples: "sample" };
  const role = roleOf[mode];
  if (!role) return;
  for (const w of state.wells) {
    if (w.role === role) { w.role = "unused"; w.conc = null; w.label = ""; }
  }
  // Leaving the ladder also drops its per-row concentrations, so coming back is
  // a clean slate rather than half-remembered values.
  if (mode === "standards") { state.rowConc = {}; renderLadderRows(); }
  if (mode === "samples") { state.rowLabel = {}; renderSampleRows(); }
}

// Every Back / Next / Compute button carries data-nav = its target phase (or the
// special values "compute" / "corners"). One delegated handler drives the wizard.
const PHASE_ORDER = ["corners", "review", "blanks", "standards", "samples", "check"];
document.querySelectorAll("[data-nav]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const to = btn.dataset.nav;
    if (to === "compute") { computeConcentrations(); return; }
    // "Re-mark corners" is meaningless on the OD path (there are none, and there
    // is no image to mark them on). The button is hidden there, so this is a
    // belt-and-braces guard against a stray data-nav.
    if (to === "corners") {
      if (state.source === "od") return;
      state.corners = []; state.wells = []; state.rowConc = {}; state.rowLabel = {};
      enterPhase("corners");
      return;
    }
    const forward = PHASE_ORDER.indexOf(to) > PHASE_ORDER.indexOf(state.mode);
    // Came here from Review via Edit? Finishing returns straight to Review.
    if (forward && state.returnTo) {
      const back = state.returnTo;
      state.returnTo = null;
      enterPhase(back, { scrollTo: "prev" });
      return;
    }
    // Going Back deletes what you did on the page you are leaving.
    if (!forward) { state.returnTo = null; clearPhaseTags(state.mode); }
    enterPhase(to, forward ? { scrollTo: "prev" } : {});
  });
});

// ---- Nudge: move or resize the whole 96-well grid at once ----
// Better than re-marking corners: it is relative, repeatable, and forgiving of
// a near-miss. Both operations transform the 4 corners, then rebuild all 96.
function nudgeGrid(dx, dy) {
  if (state.corners.length !== 4) return;
  const step = Math.max(2, (state.wellRadius || 10) * 0.35);
  state.corners = state.corners.map((c) => ({ x: c.x + dx * step, y: c.y + dy * step }));
  buildGrid();
  setVerdict("adjusted");
  redraw();
}
function scaleGrid(factor) {
  if (state.corners.length !== 4) return;
  const cx = state.corners.reduce((s, c) => s + c.x, 0) / 4;
  const cy = state.corners.reduce((s, c) => s + c.y, 0) / 4;
  state.corners = state.corners.map((c) => ({
    x: cx + (c.x - cx) * factor,
    y: cy + (c.y - cy) * factor,
  }));
  buildGrid();
  setVerdict("adjusted");
  redraw();
}

// Wire the nudge controls if present (added in index.html's corner tray-section).
const nudgeMap = {
  nudgeUp: () => nudgeGrid(0, -1),
  nudgeDown: () => nudgeGrid(0, 1),
  nudgeLeft: () => nudgeGrid(-1, 0),
  nudgeRight: () => nudgeGrid(1, 0),
  gridGrow: () => scaleGrid(1.03),
  gridShrink: () => scaleGrid(0.97),
};
for (const [id, fn] of Object.entries(nudgeMap)) {
  const btn = $(id);
  if (btn) btn.addEventListener("click", fn);
}

// Convert a click on the displayed canvas into image-pixel coordinates.
function eventToImageCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

// Corner marking is a simple click on empty space. A click that landed on an
// existing corner started a drag instead, so it must not also place a new one.
canvas.addEventListener("click", (e) => {
  if (state.mode !== "corners") return;
  if (grabbedCorner) { grabbedCorner = false; return; }
  if (state.corners.length >= 4) return;
  handleCornerClick(eventToImageCoords(e));
});

// --- Draggable corner handles ---
// Once a corner circle exists you can grab it and move it; the grid re-derives
// live underneath. Works while marking and after the grid is placed.
let draggingCorner = -1;   // index into state.corners, -1 = not dragging
let grabbedCorner = false; // the press landed on a corner (suppresses the click)
// Where the corner sat relative to the pointer when it was grabbed. Without this
// the corner would JUMP to the cursor on the first move — and since the handle is
// a full well radius wide (~100px on a real plate photo), that silently threw the
// whole grid off.
let dragOffset = { x: 0, y: 0 };

function isGridPhase() {
  return state.mode === "corners" || state.mode === "review";
}
// Which corner marker is under this point, or -1. Slightly generous so the
// handle is easy to grab.
function cornerAt(p) {
  const r = (state.wellRadius || 10) * 1.2;
  for (let i = 0; i < state.corners.length; i++) {
    const c = state.corners[i];
    if (Math.hypot(c.x - p.x, c.y - p.y) <= r) return i;
  }
  return -1;
}
// Re-derive the 96 wells from a corner set WITHOUT reordering state.corners, so
// the corner being dragged keeps its index while the preview stays untwisted.
function rebuildGridPreview() {
  if (state.corners.length === 4) buildGrid(sortCorners(state.corners));
}

// --- Well tagging: single click toggles one well; click-and-drag draws a
// rubber-band box and tags every well whose center falls inside it. ---
let selecting = false;   // pointer is down during a tagging phase
let selMoved = false;    // moved far enough to be a box drag, not a click
let selStart = null;     // press point in image coords (also used by redraw)
let selCur = null;       // current point in image coords
let pressClientX = 0, pressClientY = 0;
const DRAG_THRESHOLD = 6;  // screen px before a click becomes a box drag

// The current selection rectangle, normalised. null when not box-dragging.
function selectionBox() {
  if (!selStart || !selCur) return null;
  return {
    x0: Math.min(selStart.x, selCur.x), y0: Math.min(selStart.y, selCur.y),
    x1: Math.max(selStart.x, selCur.x), y1: Math.max(selStart.y, selCur.y),
  };
}
// A well counts as selected if the box TOUCHES ANY PART of it, not just its
// centre: clamp the well's centre into the rect and see if that lands within one
// well radius (the standard circle-vs-rectangle overlap test).
function rectHitsWell(w, b) {
  const nx = Math.max(b.x0, Math.min(w.x, b.x1));
  const ny = Math.max(b.y0, Math.min(w.y, b.y1));
  return Math.hypot(w.x - nx, w.y - ny) <= (state.wellRadius || 8);
}
function wellsInSelection() {
  const b = selectionBox();
  if (!b) return [];
  // isTaggable: on the OD path a pasted 8x6 block leaves most of the plate with
  // no reading, and sweeping a box across it must not tag wells that hold nothing.
  return state.wells.filter((w) => rectHitsWell(w, b) && isTaggable(w));
}

canvas.addEventListener("pointerdown", (e) => {
  // Grid phases: grab a corner handle if the press landed on one.
  if (isGridPhase()) {
    const p = eventToImageCoords(e);
    const i = cornerAt(p);
    if (i >= 0) {
      draggingCorner = i;
      grabbedCorner = true;
      dragOffset = { x: state.corners[i].x - p.x, y: state.corners[i].y - p.y };
      canvas.setPointerCapture(e.pointerId);
    }
    return;   // placing a new corner is handled by the click listener
  }
  if (!isTagPhase()) return;
  selecting = true;
  selMoved = false;
  selStart = eventToImageCoords(e);
  selCur = selStart;
  pressClientX = e.clientX;
  pressClientY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  // Dragging a corner: move it and re-derive the grid live.
  if (draggingCorner >= 0) {
    const p = eventToImageCoords(e);
    // Move RELATIVE to the grab point, so the corner never jumps to the cursor.
    state.corners[draggingCorner] = { x: p.x + dragOffset.x, y: p.y + dragOffset.y };
    rebuildGridPreview();
    redraw();
    return;
  }
  // Hover feedback over a grabbable corner.
  if (isGridPhase() && !selecting) {
    canvas.style.cursor = cornerAt(eventToImageCoords(e)) >= 0 ? "grab" : "crosshair";
  }
  if (!selecting) return;
  selCur = eventToImageCoords(e);
  if (!selMoved && Math.hypot(e.clientX - pressClientX, e.clientY - pressClientY) >= DRAG_THRESHOLD) {
    selMoved = true;
  }
  if (selMoved) redraw();   // draw the growing selection box
});

function endSelect(e) {
  // Finish a corner drag: settle the corner order now (not mid-drag, which would
  // yank the handle out from under the pointer) and rebuild for real.
  if (draggingCorner >= 0) {
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    draggingCorner = -1;
    if (state.corners.length === 4) {
      state.corners = sortCorners(state.corners);
      buildGrid();
    }
    updateCornerStatus();
    redraw();
    return;
  }
  if (!selecting) return;
  selecting = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

  if (selMoved && selStart && selCur) {
    // Box select: tag every well the rectangle TOUCHES (any overlap counts).
    for (const w of wellsInSelection()) applyBrush(w, { toggle: false });
  } else if (selStart) {
    // Plain click: toggle the nearest well on/off.
    const w = nearestWell(selStart);
    if (w) applyBrush(w, { toggle: true });
  }
  selStart = selCur = null;
  // The ladder's per-row fields follow whatever is now selected.
  if (state.mode === "standards") renderLadderRows();
  if (state.mode === "samples") renderSampleRows();
  updatePhaseVerdict();   // the banner tracks this step's count live
  redraw();
}
canvas.addEventListener("pointerup", endSelect);
canvas.addEventListener("pointercancel", endSelect);

function handleCornerClick(p) {
  state.corners.push(p);
  updateCornerStatus();
  if (state.corners.length === 4) {
    // Sort the four clicks into TL, TR, BL, BR by position so the grid can never
    // come out twisted (a "bowtie") if they were clicked in a crossing order.
    state.corners = sortCorners(state.corners);
    buildGrid();
    enterPhase("review");
  } else {
    redraw();
  }
}

// Assign four arbitrary-order points to TL, TR, BL, BR by their coordinates.
// Assumes the plate is roughly upright (not rotated past ~45°), which holds for
// any usable plate photo.
function sortCorners(pts) {
  const byY = [...pts].sort((a, b) => a.y - b.y);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x); // TL, TR
  const bot = byY.slice(2).sort((a, b) => a.x - b.x);     // BL, BR
  return [top[0], top[1], bot[0], bot[1]];
}

// Keeps both the little "N / 4 corners" chip and the prominent verdict banner in
// step with the marking progress. During the corners phase the banner IS the
// instruction, so it names the order and counts down live.
function updateCornerStatus() {
  const n = state.corners.length;
  updateResetBtn();
  const el = $("cornerStatus");
  if (el) el.textContent = `${n} / 4 corners`;
  if (state.mode === "corners") {
    const v = $("gridVerdict");
    if (v) {
      v.classList.remove("is-found", "is-adjusted");
      v.classList.add("is-setup");
      v.innerHTML =
        `<span class="flag flag-caution"><i></i>${n} / 4</span>` +
        `<span class="verdict-text">Tag the four corner wells in order: ` +
        `top-left → top-right → bottom-left → bottom-right.</span>`;
    }
  }
}

// Linear interpolation between two points.
// Derive all 96 well centers from the 4 marked corners. The geometry itself
// lives in core/plate.js; this just parks the result in app state.
function buildGrid(corners = state.corners) {
  const { wells, wellRadius } = buildGridGeometry(corners);
  state.wells = wells;
  state.wellRadius = wellRadius;
}

// ============================================================
// Row-based tagging: the ladder and the samples both work per PLATE ROW
//
// You select the wells on the plate, then fill one field per row: a
// concentration for the ladder, a name for the samples. Every well in a row
// carries that row's value, which IS the replicate assumption — same row =
// replicates (triplicates on a standard plate).
// ============================================================

// The standard BSA 2-fold series, top row down. Used to prefill the ladder so a
// normal plate needs no typing at all.
const LADDER_DEFAULTS = [0, 31.25, 62.5, 125, 250, 500, 1000, 2000];

// Which plate rows hold wells of a given role, top to bottom.
function rowsWithRole(role) {
  return [...new Set(state.wells.filter((w) => w.role === role).map((w) => w.row))]
    .sort((a, b) => a - b);
}

// Push state.rowConc onto every standard well.
function syncRowConcs() {
  for (const w of state.wells) {
    if (w.role !== "standard") continue;
    const c = state.rowConc[w.row];
    w.conc = c === undefined || c === null || isNaN(c) ? null : c;
    w.label = w.conc == null ? "" : `${w.conc}`;
  }
}

// Push state.rowLabel onto every sample well, one name per BLOCK of replicates
// rather than per row — a row can hold more than one sample once the plate needs
// a second block of columns (core/plate.js → sampleBlocks). An empty name is left
// empty on purpose: the core groups samples by label, so a blank one would
// silently make each well its own sample instead of a replicate group.
function syncRowLabels() {
  // Wipe first: a well that has left a group (untagged, or re-chunked by a new
  // replicate count) must not keep the name its old group gave it.
  for (const w of state.wells) if (w.role === "sample") w.label = "";
  for (const g of sampleBlocks(state.wells, state.replicates)) {
    const l = state.rowLabel[g.key];
    const name = l && String(l).trim() ? String(l).trim() : "";
    for (const w of g.wells) w.label = name;
  }
}

// The LADDER's fields: one concentration per row that holds standard wells.
// Samples used to share this renderer and no longer do — see renderSampleRows.
function renderRowFields({ boxId, role }) {
  const box = $(boxId);
  if (!box) return;
  const rows = rowsWithRole(role);
  if (!rows.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;

  // Prefill any row we have not seen before with the standard BSA series, keyed
  // to the PLATE ROW (A=0, B=31.25 … H=2000) rather than the selection order, so
  // it stays correct whether or not row A went to the blanks step. Only
  // `undefined` is prefilled, so a field you deliberately cleared stays cleared.
  rows.forEach((r) => {
    if (state.rowConc[r] === undefined && r < LADDER_DEFAULTS.length) {
      state.rowConc[r] = LADDER_DEFAULTS[r];
    }
  });
  syncRowConcs();

  box.innerHTML = rows
    .map((r) => {
      const n = state.wells.filter((w) => w.role === role && w.row === r).length;
      const letter = String.fromCharCode(65 + r);
      const val = state.rowConc[r] ?? "";
      const attrs = `type="number" class="row-input is-conc" placeholder="µg/mL" min="0" step="any" aria-label="Concentration for row ${letter}"`;
      return (
        `<div class="row-field">` +
        `<span class="row-field-label">Row ${letter}</span>` +
        `<span class="hint-inline">${n} well${n === 1 ? "" : "s"} · replicates</span>` +
        `<input ${attrs} data-row="${r}" value="${val}" />` +
        `</div>`
      );
    })
    .join("");

  // Typing a row's concentration applies it to every standard well in that row.
  box.querySelectorAll(".row-input").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const r = Number(e.target.dataset.row);
      const v = parseFloat(e.target.value);
      state.rowConc[r] = isNaN(v) ? null : v;
      syncRowConcs();
      updatePhaseVerdict("standards");
      redraw();
    });
  });
}

const renderLadderRows = () => renderRowFields({ boxId: "ladderRows", role: "standard" });

// ============================================================
// Sample naming: one field per BLOCK of replicates, not per row.
//
// The ladder still renders per row (renderRowFields above) and that is correct —
// standards are identified by the concentration you type, so two ladder blocks at
// the same concentrations merge into more replicates, which is what you want.
// Samples are identified by NAME, so the same merge silently destroys data. The
// two models diverged for a real reason; forcing them back through one renderer
// would mean a `kind === "name"` branch in every line of it.
//
// See core/plate.js → sampleBlocks for why this needs a replicate count instead
// of detecting the split.
// ============================================================
function renderSampleRows() {
  const box = $("sampleRows");
  if (!box) return;
  const groups = sampleBlocks(state.wells, state.replicates);
  if (!groups.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;

  // Prefill in the order the plate gets filled — down block one, then down block
  // two — so a fresh 12-sample plate comes out S1…S12 where a human expects them.
  // Only `undefined` is prefilled, so a name you deliberately cleared stays
  // cleared and a name you typed survives a re-chunk.
  //
  // NEVER hand out a name that is already taken. `S${i+1}` by position looks fine
  // on a fresh plate and collides after a re-chunk, where some keys carry names
  // from the old split and the new indices walk over them. Two groups with the
  // same name are MERGED BY THE CORE — the identical silent-merge bug this whole
  // block-splitting model exists to prevent, re-entered through the back door.
  // Orphaned keys keep their names reserved too, so undoing a re-chunk restores
  // the old split instead of colliding with it.
  const taken = new Set(
    Object.values(state.rowLabel).map((v) => String(v ?? "").trim()).filter(Boolean)
  );
  let next = 1;
  for (const g of groups) {
    if (state.rowLabel[g.key] !== undefined) continue;
    while (taken.has(`S${next}`)) next++;
    state.rowLabel[g.key] = `S${next}`;
    taken.add(`S${next}`);
  }
  syncRowLabels();


  const multiBlock = groups.some((g) => g.block > 0);

  // Lay the fields out AS THE PLATE IS: one grid column per block, one grid row
  // per plate row. Two columns of samples on the plate become two columns of
  // names, and a block that stops at row D leaves the rest of its column empty —
  // the same hole the wells have. Reading the list becomes reading the plate.
  const nBlocks = Math.max(...groups.map((g) => g.block)) + 1;
  box.classList.add("is-plate");
  box.style.gridTemplateColumns = `repeat(${nBlocks}, minmax(0, 1fr))`;

  box.innerHTML = groups
      .map((g) => {
        const letter = String.fromCharCode(65 + g.row);
        const cols = g.wells.map((w) => w.col + 1);
        const span = cols.length > 1 ? `${cols[0]}–${cols[cols.length - 1]}` : `${cols[0]}`;
        // Name the WELLS, not the row, once a row can hold two samples: "Row A"
        // would be ambiguous exactly when it matters most.
        const label = multiBlock ? `${letter}${span}` : `Row ${letter}`;
        const val = state.rowLabel[g.key] ?? "";
        const short = g.wells.length < state.replicates;
        // The same green this group's wells are outlined in on the plate, so a
        // field and its wells are matchable without counting rows. Decorative
        // only — the label beside it already says which wells these are, which is
        // what keeps identity off the colour channel.
        const chip = SAMPLE_GREENS[(g.row + g.block) % SAMPLE_GREENS.length];
        const wellNames = g.wells.map((w) => `${letter}${w.col + 1}`).join(", ");
        const hint = `${g.wells.length} well${g.wells.length === 1 ? "" : "s"}` +
          // A stray leftover well is how a mis-set replicate count shows itself.
          (short ? ` · fewer than ${state.replicates} — check the replicate count` : " · replicates");
        return (
          // grid-row/-column place this field at the same spot its wells occupy on
          // the plate. 1-based, hence the +1.
          `<div class="row-field${short ? " is-short" : ""}" style="grid-column:${g.block + 1};grid-row:${g.row + 1}">` +
          `<span class="group-chip" style="background:${chip}" aria-hidden="true"></span>` +
          `<span class="row-field-label">${label}</span>` +
          `<span class="hint-inline">${hint}</span>` +
          // The hint is hidden in the narrow grid columns, so it lives on as the
          // title — the "check the replicate count" warning must not just vanish.
          `<input type="text" class="row-input" placeholder="name" title="${wellNames} — ${hint}" aria-label="Name for wells ${wellNames}" data-key="${g.key}" value="${val}" />` +
          `</div>`
        );
      })
      .join("");

  box.querySelectorAll(".row-input[data-key]").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      state.rowLabel[e.target.dataset.key] = e.target.value;
      syncRowLabels();
      updatePhaseVerdict("samples");
      redraw();
    });
  });

}

// The Replicates control lives in step 5's HEAD (index.html), so it is bound ONCE
// here rather than re-bound on every render of the field list.
//
// Names are NOT wiped when it changes. Group keys are `row:block`, so most
// survive a re-chunk and keep the name you typed; only genuinely new groups get a
// prefilled S-number, and a group that disappears leaves its name behind, so
// undoing the change restores the old split. This used to reset state.rowLabel
// wholesale — which threw away every name on the plate the instant you nudged the
// field, after you had typed twelve of them.
const replicatesInput = $("replicatesInput");
if (replicatesInput) {
  replicatesInput.value = state.replicates; // seed from state; no default in the HTML to drift
  replicatesInput.addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    if (!(v >= 1 && v <= COLS)) return; // a half-typed or silly value changes nothing
    state.replicates = v;
    renderSampleRows();
    updatePhaseVerdict("samples");
    redraw();
  });
}

// ============================================================
// Review & edit (step 6): the last look before reading the plate
// ============================================================

// What still stands between this plate and a real answer. Empty = ready.
function reviewIssues() {
  const issues = [];
  const stds = state.wells.filter((w) => w.role === "standard");
  const samps = state.wells.filter((w) => w.role === "sample");

  if (!stds.length) {
    issues.push("the ladder has no wells");
  } else {
    const rows = [...new Set(stds.map((w) => w.row))];
    const missing = rows.filter((r) => state.rowConc[r] == null || isNaN(state.rowConc[r]));
    if (missing.length) issues.push(`${missing.length} ladder row${missing.length === 1 ? "" : "s"} without a concentration`);
    // The curve needs at least two distinct points to exist at all. Blanks count
    // as the zero point, which is why they are folded in here.
    const concs = new Set(rows.map((r) => state.rowConc[r]).filter((c) => c != null && !isNaN(c)));
    if (state.wells.some((w) => w.role === "blank")) concs.add(0);
    if (concs.size < 2) issues.push("the ladder needs at least two different concentrations");
  }
  if (!samps.length) {
    issues.push("no samples are marked");
  } else {
    const unnamed = sampleBlocks(state.wells, state.replicates).filter((g) => {
      const l = state.rowLabel[g.key];
      return !l || !String(l).trim();
    });
    if (unnamed.length) issues.push(`${unnamed.length} sample${unnamed.length === 1 ? "" : "s"} without a name`);
  }
  return issues;
}

function updateReviewVerdict() {
  const v = $("reviewVerdict");
  if (!v) return;
  const issues = reviewIssues();
  v.classList.remove("is-setup", "is-found");
  if (issues.length) {
    v.classList.add("is-setup");
    v.innerHTML =
      `<span class="flag flag-caution"><i></i>Not ready</span>` +
      `<span class="verdict-text">${issues.join("; ")}. Use Edit to fix it.</span>`;
  } else {
    v.classList.add("is-found");
    v.innerHTML =
      `<span class="flag flag-ok"><i></i>Ready to read</span>` +
      `<span class="verdict-text">Everything is tagged. Hit Looks right to read the plate.</span>`;
  }
  setStepGate("reviewCard", issues.length === 0, issues.join("; "));
}

// One line per part, each with an Edit jump back into that step.
function renderReviewParts() {
  const box = $("reviewParts");
  if (!box) return;
  const blanks = state.wells.filter((w) => w.role === "blank");
  const stds = state.wells.filter((w) => w.role === "standard");
  const samps = state.wells.filter((w) => w.role === "sample");
  const rungs = new Set(stds.map((w) => w.row)).size;
  const names = new Set(samps.map((w) => w.label).filter(Boolean)).size;

  const parts = [
    { phase: "blanks", label: "Blanks",
      detail: blanks.length ? `${blanks.length} well${blanks.length === 1 ? "" : "s"}` : "none" },
    { phase: "standards", label: "Ladder",
      detail: stds.length ? `${rungs} rung${rungs === 1 ? "" : "s"} · ${stds.length} wells` : "none" },
    { phase: "samples", label: "Samples",
      detail: samps.length ? `${names} named · ${samps.length} wells` : "none" },
  ];

  box.innerHTML = parts
    .map((p) =>
      `<div class="row-field">` +
      `<span class="row-field-label">${p.label}</span>` +
      `<span class="hint-inline">${p.detail}</span>` +
      `<button class="btn btn-secondary" data-edit="${p.phase}">Edit</button>` +
      `</div>`
    )
    .join("");

  // Edit jumps into that step and remembers to come back here. It does NOT clear
  // anything — unlike Back, editing is meant to preserve what you already did.
  box.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.returnTo = "check";
      enterPhase(btn.dataset.edit);
    });
  });
}

// Find the well closest to a point, or null if the click was off the grid.
function nearestWell(p) {
  let nearest = null;
  let best = Infinity;
  for (const w of state.wells) {
    if (!isTaggable(w)) continue; // OD path: a well with no reading is not a target
    const d = Math.hypot(w.x - p.x, w.y - p.y);
    if (d < best) { best = d; nearest = w; }
  }
  if (!nearest || best > state.wellRadius * 2.5) return null;
  return nearest;
}

// Tag one well with the current brush. With { toggle:true } a well that ALREADY
// carries exactly this brush's tag is cleared instead (single-click on/off).
// During a drag we pass toggle:false so sweeping always paints, never erases.
function applyBrush(well, { toggle }) {
  const role = state.brush.role;

  const alreadyThis =
    (role === "blank"    && well.role === "blank") ||
    (role === "standard" && well.role === "standard") ||
    (role === "sample"   && well.role === "sample");

  if (role === "unused" || (toggle && alreadyThis)) {
    well.role = "unused";
    well.conc = null;
    well.label = "";
  } else if (role === "blank") {
    well.role = "blank";
    well.conc = 0;
    well.label = "";
  } else if (role === "standard") {
    // The concentration is NOT set here — it comes from this well's plate row
    // (state.rowConc), which the user fills in per row after selecting.
    well.role = "standard";
    const c = state.rowConc[well.row];
    well.conc = c === undefined || c === null || isNaN(c) ? null : c;
    well.label = well.conc == null ? "" : `${well.conc}`;
  } else if (role === "sample") {
    // The name is NOT set here. A sample's name belongs to its BLOCK of
    // replicates, and tagging this well may have just changed how its row chunks
    // into blocks — so the label cannot be known until the whole row is
    // re-chunked. syncRowLabels() does that, driven by renderSampleRows().
    well.role = "sample";
    well.conc = null;
    well.label = "";
  }
}

// ============================================================
// Compute: sample pixels, hand off to the core, render the answer
//
// The science is NOT here. This reads the two controls, puts a colour on every
// tagged well, calls the core, and renders. That is the whole job of this
// section. See docs/adr/0001-extract-math-core.md.
// Triggered by the samples step's Compute button (data-nav="compute").
// ============================================================

function computeConcentrations() {
  const channel = $("channelSelect").value;
  // Keep this fallback in step with the `selected` option in index.html.
  const fitMode = $("fitMode") ? $("fitMode").value : DEFAULT_FIT;

  // Put a colour on every tagged well. This is the edge's job because it needs
  // pixels: demo wells carry their true BCA colour (the plate pixels are blank
  // on purpose), a real uploaded photo gets sampled from the image itself.
  //
  // The OD path skips this entirely: its wells already carry a `signal` (the
  // instrument's reading), so there is nothing to sample and no image to sample
  // from. This `if` IS the seam — below it, nothing knows which path ran.
  if (state.source !== "od") {
    for (const w of state.wells) {
      if (w.role === "unused") continue;
      w.color =
        w.demoColor ||
        sampleColorAt(
          state.baseImageData.data,
          state.naturalW,
          state.naturalH,
          w.x,
          w.y,
          state.wellRadius
        );
    }
  }

  // Hand off to the single source of truth.
  const result = coreCompute(state.wells, { channel, fitMode });

  // The core states the problem; the edge decides how to say it.
  if (!result.ok) {
    alert(result.error);
    return;
  }

  renderResults(result.fit, result.standardPts, result.sampleResults, result.warnings);
}

// ============================================================
// Results rendering
// ============================================================

function renderResults(fit, standardPts, sampleResults, warnings) {
  $("resultsCard").hidden = false;

  // Hand the reads to Step 8. If a plan is already on screen it must follow the
  // new numbers: a stale plan next to fresh concentrations is a pipetting error
  // waiting to happen.
  state.sampleResults = sampleResults;
  state.fit = fit; // kept so the CSV can record which curve produced these numbers
  if (!$("loadingCard").hidden) renderPlan();

  // Fit equation + R^2 (+ which model was used).
  const modelName =
    fit.type === "4pl" ? "4PL logistic" : fit.type === "quad" ? "curved" : "linear";
  $("fitLine").textContent = `${fit.equation}   |   R² = ${fit.r2.toFixed(4)}   |   ${modelName} fit`;

  // Trust-warning panel.
  const warnBox = $("warnings");
  if (warnBox) {
    if (warnings && warnings.length) {
      warnBox.hidden = false;
      warnBox.innerHTML =
        `<strong>Check these reads:</strong><ul>${warnings.map((w) => `<li>${w}</li>`).join("")}</ul>`;
    } else {
      warnBox.hidden = true;
      warnBox.innerHTML = "";
    }
  }

  // Sample table: label · n · signal · conc · status.
  const tbody = $("resultsTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const s of sampleResults) {
    const tr = document.createElement("tr");
    const conc = isFinite(s.estConc) ? s.estConc.toFixed(1) : "—";
    const flagged = s.flags.length > 0;
    if (flagged) tr.className = "row-flag";
    const status = flagged
      ? `<span class="status-warn">⚠ ${s.flags.join("; ")}</span>`
      : `<span class="status-ok">✓ ok</span>`;
    // `ta-r num` per cell, same contract as Step 8's table: alignment travels
    // with the class the header uses, so the two cannot drift apart. This
    // replaces an nth-child list in the CSS that had gone out of step with its
    // own headers (right-aligned titles over left-aligned numbers).
    tr.innerHTML =
      `<td>${s.label}</td>` +
      `<td class="ta-r num">${s.n}</td>` +
      `<td class="ta-r num">${s.netSignal.toFixed(state.source === "od" ? 3 : 1)}</td>` +
      `<td class="ta-r num">${conc}</td>` +
      `<td>${status}</td>`;
    tbody.appendChild(tr);
  }

  // The disclaimer is about the SOURCE, so it cannot be static. Telling someone
  // who pasted instrument readings that their accuracy depends on even lighting
  // is not just noise — it aims their suspicion at the wrong thing.
  const disc = $("resultsDisclaimer");
  if (disc) {
    disc.textContent =
      state.source === "od"
        ? "These are your plate reader's own readings, fitted here rather than in a spreadsheet. Accuracy is the instrument's, not a camera's. Note the curve is fitted to YOUR ladder, so it does not depend on a slope value copied off a trendline label."
        : "Educational tool. Accuracy depends on even lighting and a flat, glare-free photo. Always shoot your standards in the same photo as your samples, and re-shoot standards every run: curves do not carry across lighting.";
  }

  // Per-rung readback: what each standard actually measured vs what the curve
  // says it should. A big residual on one rung means that row is sampling the
  // wrong pixels, which the plot alone is too small to reveal.
  const lt = $("ladderTable");
  if (lt) {
    const lb = lt.querySelector("tbody");
    lb.innerHTML = "";
    // `p.off` and `p.fit` are the CORE's verdict now, not this file's. They used
    // to be computed here against `Math.max(5, ...)` — an absolute noise floor in
    // photo units that could never fire on an OD (see core/thresholds.js).
    // A threshold typed into a screen is a threshold that drifts (ADR 0001).
    //
    // Signal is printed to 3 decimals on the OD path: an OD runs 0..2, so the
    // photo path's 1 decimal would round every rung to "0.1" and "0.3".
    const dp = state.source === "od" ? 3 : 1;
    for (const p of standardPts) {
      const tr = document.createElement("tr");
      if (p.off) tr.className = "row-flag";
      tr.innerHTML =
        `<td>${p.x}</td><td>${p.n}</td><td>${p.y.toFixed(dp)}</td>` +
        `<td>${isFinite(p.fit) ? p.fit.toFixed(dp) : "—"}</td>` +
        `<td>${p.cv.toFixed(1)}</td>`;
      lb.appendChild(tr);
    }
  }

  drawStandardPlot(fit, standardPts, sampleResults);

  // Collapse the whole wizard to green-check confirmations. Snap so the last
  // step's check sits at the top, with Results just below it (same rule as every
  // other "Looks right").
  WIZARD_CARDS.forEach((id) => {
    const c = $(id);
    if (c) { c.hidden = false; c.classList.add("is-done"); setCardSummary(id); }
  });
  scrollStepToTop($("reviewCard"));
}

// Small scatter plot of standards + fitted curve + projected samples.
// Works for any fit model by sampling fit.predict() across the x-range.
function drawStandardPlot(fit, standardPts, sampleResults) {
  const pc = $("plotCanvas");
  const g = pc.getContext("2d");
  const W = pc.width, H = pc.height;
  const pad = 42;
  g.clearRect(0, 0, W, H);

  // Axis ranges.
  const sampleConcs = sampleResults.map((s) => s.estConc).filter(isFinite);
  const xs = standardPts.map((p) => p.x).concat(sampleConcs);
  const ys = standardPts.map((p) => p.y).concat(sampleResults.map((s) => s.netSignal));
  const xMax = Math.max(...xs, 1) * 1.05;
  const yMax = Math.max(...ys, 1) * 1.05;
  const yMin = Math.min(...ys, 0);

  const X = (v) => pad + (v / xMax) * (W - pad - 12);
  const Y = (v) => H - pad - ((v - yMin) / (yMax - yMin)) * (H - pad - 12);

  // Axes. Colours tuned for the plot's NEUTRAL WHITE ground (--stage rule): the
  // curve sits on white now, not a dark panel, so lines/labels must be dark.
  g.strokeStyle = "#d2d2da";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(pad, 12); g.lineTo(pad, H - pad); g.lineTo(W - 12, H - pad);
  g.stroke();
  g.fillStyle = "#55555e";
  g.font = "11px system-ui";
  g.fillText("signal", 6, 16);
  g.fillText("conc (µg/mL)", W - 90, H - 14);

  // Fitted curve — sample predict() across the range so a line draws straight
  // and a quadratic draws as a smooth curve, with no special-casing.
  g.strokeStyle = "#7c5cff";
  g.lineWidth = 2;
  g.beginPath();
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const cx = (i / steps) * xMax;
    const py = fit.predict(cx);
    if (i === 0) g.moveTo(X(cx), Y(py));
    else g.lineTo(X(cx), Y(py));
  }
  g.stroke();

  // Standard points. Darker purple than the curve so they read on white.
  g.fillStyle = "#6347e0";
  for (const p of standardPts) {
    g.beginPath(); g.arc(X(p.x), Y(p.y), 4, 0, Math.PI * 2); g.fill();
  }

  // Projected sample points (at their estimated conc + measured signal).
  g.fillStyle = "#4ade80";
  for (const s of sampleResults) {
    if (!isFinite(s.estConc)) continue;
    g.beginPath(); g.arc(X(s.estConc), Y(s.netSignal), 4, 0, Math.PI * 2); g.fill();
  }
}

// ============================================================
// CSV export
// ============================================================

$("csvBtn").addEventListener("click", (e) => {
  // Provenance travels with the numbers, same contract as Step 8's plan CSV.
  // This app now has two sources that disagree by ~5% (CONTEXT.md → "RESOLVED
  // 2026-07-16"), so a column of concentrations with no note of where it came
  // from is a number nobody can audit later — including you, next week.
  const od = state.source === "od";
  let csv = `# BCA Reader results\n`;
  csv += `# source: ${od ? "plate reader data (pasted OD readings)" : "plate photo"}\n`;
  if (state.fit) {
    csv += `# fit: ${state.fit.type} | R2 = ${state.fit.r2.toFixed(4)} | ${state.fit.equation}\n`;
  }
  csv += od
    ? `# signal column is the instrument's OD.\n`
    : `# signal column is 255-green off the photo. NOTE: the photo path reads ~5% high\n# against the corrected truth; per-sample error can be worse. Prefer pasted\n# plate reader data when you have it.\n`;
  csv += "well,role,label,signal,conc_ugml\n";
  for (const w of state.wells) {
    if (w.role === "unused") continue;
    const conc = w.role === "sample"
      ? (isFinite(w.estConc) ? w.estConc.toFixed(1) : "")
      : (w.conc ?? "");
    const sig = isFinite(w.signal) ? w.signal.toFixed(od ? 4 : 2) : "";
    csv += `${w.name},${w.role},${w.label || ""},${sig},${conc}\n`;
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "bca-results.csv";
  a.click();

  // In-place feedback instead of a toast: the confirmation lands on the button
  // the user just pressed. Restores after a beat.
  const btn = e.currentTarget;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
  btn.classList.add("is-done");
  btn.textContent = "Exported";
  setTimeout(() => {
    btn.classList.remove("is-done");
    btn.textContent = btn.dataset.label;
  }, 1400);
});

// ============================================================
// Step 8: the gel loading plan
//
// Again: NO science here. Every volume, every cutoff, and the too-dilute rule
// live in ../core/loading.js, which the offline harness imports too. This block
// reads five fields, calls the core, and renders. A real lab's WB prep sheet is
// the model — the cell-by-cell derivation is documented in core/loading.js.
// ============================================================

const PLAN_FIELDS = ["dilutionFactor", "targetMass", "finalVolume", "dyeX", "loadPerLane"];

// Seed the fields from the core's defaults so the shipped protocol numbers have
// exactly one home. A default typed into the HTML is a default that will drift.
for (const id of PLAN_FIELDS) {
  const el = $(id);
  if (el) el.value = LOADING_DEFAULTS[id];
}
$("dilutionHint").textContent = DILUTION_NOTE;

function renderPlan() {
  const opts = {};
  for (const id of PLAN_FIELDS) opts[id] = parseFloat($(id).value);

  const warnBox = $("loadingWarnings");
  const tbody = $("loadingTable").querySelector("tbody");
  const verdict = $("loadingVerdict");

  const plan = corePlan(state.sampleResults || [], opts);
  state.plan = plan; // set BEFORE any render: setCardSummary + CSV both read it

  // The core states the problem; the edge decides how to say it. A bad field is
  // not an alert() — it turns the banner amber and blanks the table, so nobody
  // reads volumes computed from a number that was rejected.
  if (!plan.ok) {
    tbody.innerHTML = "";
    verdict.className = "verdict is-setup";
    verdict.innerHTML =
      `<span class="flag flag-caution"><i></i>Cannot plan</span>` +
      `<span class="verdict-text">${plan.error}</span>`;
    warnBox.hidden = true;
    setCardSummary("loadingCard");
    return;
  }

  const s = plan.shared;

  // The headline is the whole protocol in one line: what every tube gets and
  // what a lane therefore carries. This is the number the bench actually wants.
  verdict.className = "verdict is-found";
  verdict.innerHTML =
    `<span class="flag flag-ok"><i></i>Plan ready</span>` +
    `<span class="verdict-text">Every tube: <strong>${s.targetMass} µg</strong> in ` +
    `<strong>${s.finalVolume} µL</strong> (${s.dyeVolume.toFixed(1)} µL of ${s.dyeX}x dye, ` +
    `sample + lysis buffer share the other ${s.budget.toFixed(1)} µL) → ` +
    `<strong>${s.finalConc.toFixed(3)} µg/µL</strong>, so ${s.loadPerLane} µL per lane = ` +
    `<strong>${s.massPerLane.toFixed(2)} µg per lane</strong>.</span>`;

  $("dyeHint").textContent =
    `${s.dyeVolume.toFixed(1)} µL — ${s.dyeX}x dye takes 1/${s.dyeX} of the final volume.`;

  if (plan.warnings.length) {
    warnBox.hidden = false;
    warnBox.innerHTML =
      `<strong>Check these before you pipette:</strong><ul>` +
      plan.warnings.map((w) => `<li>${w}</li>`).join("") + `</ul>`;
  } else {
    warnBox.hidden = true;
    warnBox.innerHTML = "";
  }

  tbody.innerHTML = "";
  for (const r of plan.rows) {
    const tr = document.createElement("tr");
    const flagged = r.flags.length > 0;
    if (flagged) tr.className = "row-flag";
    // `ta-r num` on every numeric cell: right-aligned under its right-aligned
    // header, mono + tabular so the µL columns line up decimal-to-decimal. The
    // classes carry it, not nth-child, so inserting a column cannot break it.
    const n = (v, d = 1) =>
      `<td class="ta-r num">${isFinite(v) ? v.toFixed(d) : "—"}</td>`;
    const status = flagged
      ? `<span class="status-warn">⚠ ${r.flags.join("; ")}</span>`
      : `<span class="status-ok">✓ ok</span>`;
    tr.innerHTML =
      `<td>${r.label}</td>` +
      n(r.readConc) + n(r.stockConc) + n(r.sampleUl) + n(r.bufferUl) + n(r.dyeUl) +
      `<td>${status}</td>`;
    tbody.appendChild(tr);
  }

  setCardSummary("loadingCard");
}

// Every field re-plans live. The arithmetic is trivial and the feedback loop is
// the point: you should be able to dial the target mass down until a flagged sample stops
// complaining and watch it happen.
for (const id of PLAN_FIELDS) {
  const el = $(id);
  if (el) el.addEventListener("input", () => { if (!$("loadingCard").hidden) renderPlan(); });
}

$("planBtn").addEventListener("click", (e) => {
  e.preventDefault();
  $("loadingCard").hidden = false;
  renderPlan();
  scrollStepToTop($("loadingCard"));
});

$("planBackBtn").addEventListener("click", (e) => {
  e.preventDefault();
  scrollStepToTop($("resultsCard"));
});

$("planCsvBtn").addEventListener("click", (e) => {
  const plan = state.plan;
  if (!plan || !plan.ok) return;
  const s = plan.shared;

  // The protocol is carried in the file as comments. A volumes-only CSV opened
  // next week is unreadable: 78.6 µL of what, to hit what mass?
  let csv = `# BCA Reader gel loading plan\n`;
  csv += `# target ${s.targetMass} ug per tube in ${s.finalVolume} uL final\n`;
  csv += `# dilution factor ${s.dilutionFactor}x | dye ${s.dyeX}x = ${s.dyeVolume.toFixed(1)} uL\n`;
  csv += `# final ${s.finalConc.toFixed(4)} ug/uL | load ${s.loadPerLane} uL per lane = ${s.massPerLane.toFixed(2)} ug per lane\n`;
  csv += `sample,read_ugml,stock_ugml,sample_ul,lysis_buffer_ul,dye_ul,flags\n`;
  for (const r of plan.rows) {
    const n = (v, d = 2) => (isFinite(v) ? v.toFixed(d) : "");
    csv += `${r.label},${n(r.readConc)},${n(r.stockConc)},${n(r.sampleUl)},${n(r.bufferUl)},${n(r.dyeUl)},"${r.flags.join("; ")}"\n`;
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gel-loading-plan.csv";
  a.click();

  const btn = e.currentTarget;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
  btn.classList.add("is-done");
  btn.textContent = "Exported";
  setTimeout(() => {
    btn.classList.remove("is-done");
    btn.textContent = btn.dataset.label;
  }, 1400);
});

// ============================================================
// Canvas redraw (image + grid overlay)
// ============================================================

// Role palette, shared by both renderers so a blank is the same blue whichever
// path you came in on.
const ROLE_COLOR = {
  blank: "#7dd3fc",
  standard: "#c4b5ff",
  sample: "#4ade80",
  unused: "rgba(255,255,255,0.25)",
};

// ============================================================
// Two greens, alternating per replicate group.
//
// THE JOB: make the boundary between neighbouring samples visible. With 12
// samples the plate grows a second block of columns and row A holds sample 1
// (cols 4-6) AND sample 9 (cols 7-9) — six identical green wells that look like
// one sample. That is the same confusion core/plate.js exists to prevent, except
// on screen instead of in the arithmetic.
//
// WHY TWO AND NOT TWELVE. Colour is not carrying identity here — the NAME is
// drawn on every well, and a group is a contiguous run. Colour only has to answer
// "does this well belong to the same sample as the one beside it", and group
// adjacency on a plate is a GRID, which is 2-colourable: a checkerboard on
// (row + block) guarantees every touching pair differs. Twelve colours would
// answer a question nobody asked and fail doing it — validated with the dataviz
// skill's checker (all-pairs, since any two groups can sit side by side):
//
//   2 greens  #22c55e/#166534  PASS  ΔE 28.7 normal, 27.9 deuteranopia
//   3 (+teal)                  FAIL  ΔE 10.7 — under the 15 normal-vision floor
//   4 (+lime)                  FAIL  ΔE 9.5
//
// Below that floor, readers with FULL colour vision cannot reliably tell the pair
// apart, so a third shade would have looked richer and been worse. Both of these
// are unmistakably green, so "green = sample" survives the split.
//
// THIS PAIR IS AS FAR APART AS THE GREEN FAMILY GETS. #166534 sits exactly on the
// lightness band's floor (L 0.43) and #22c55e near its ceiling — every darker
// green (#14532d, ΔE 34.6) and every lighter one (#4ade80, ΔE 36.0) scores better
// on paper and FAILS the band, where a colour stops holding its hue and starts
// reading as black or as wash. Do not "improve" this by grabbing the higher ΔE.
//
// The checker WARNs that #22c55e is 2.13:1 on the plate surface, which it allows
// only with "visible labels or a table view". Both are present: the name is on
// the well and the name fields are listed under the plate.
// ============================================================
const SAMPLE_GREENS = ["#22c55e", "#166534"];

// Same green, as a translucent fill. The BORDER alone was too quiet to read at a
// glance (3px of hue on a cell that already carries an OD shade underneath), so
// the group's colour tints the whole well and the border sharpens it.
function withAlpha(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbaToRgb(css) {
  const [r, g, b] = css.match(/[\d.]+/g).map(Number);
  return { r, g, b };
}
// What `over` at `a` alpha actually leaves on top of `base`.
function blend(base, over, a) {
  return {
    r: base.r * (1 - a) + over.r * a,
    g: base.g * (1 - a) + over.g * a,
    b: base.b * (1 - a) + over.b * a,
  };
}
// Perceived lightness, 0..1. Enough to choose ink; not a WCAG contrast figure.
function luminance({ r, g, b }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// well -> its group's green. Built once per redraw; cheap, and it keeps the
// checkerboard rule in exactly one place.
function sampleShades() {
  const m = new Map();
  for (const g of sampleBlocks(state.wells, state.replicates)) {
    const shade = SAMPLE_GREENS[(g.row + g.block) % SAMPLE_GREENS.length];
    for (const w of g.wells) m.set(w, shade);
  }
  return m;
}
// Translucent fills so a tagged well visibly "fills in" with its role color
// (purple for standards) instead of only getting a thin outline.
const ROLE_FILL = {
  blank: "rgba(125, 211, 252, 0.45)",
  standard: "rgba(124, 92, 255, 0.55)",
  sample: "rgba(74, 222, 128, 0.45)",
};

// ---- The OD plate: cells of numbers instead of a photograph ----
//
// Why draw the plate at all instead of listing the numbers in a table: the ladder
// shows up as a visible gradient down its columns and the blanks are visibly the
// palest wells, so a block pasted one row off, or rotated, is obvious at a glance
// rather than being arithmetic you have to check. The shading is a readability
// aid, not data — nothing samples these pixels.
function drawODPlate(shades) {
  ctx.fillStyle = "#f6f7fb";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Column numbers and row letters in the gutters, so "that block sits at A1"
  // is something you can verify rather than take on faith.
  ctx.fillStyle = "#6b7280";
  ctx.font = "600 15px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let c = 0; c < COLS; c++) {
    ctx.fillText(String(c + 1), OD_MARGIN_L + (c + 0.5) * OD_CELL_W, OD_MARGIN_T / 2 + 6);
  }
  for (let r = 0; r < ROWS; r++) {
    ctx.fillText(String.fromCharCode(65 + r), OD_MARGIN_L / 2 + 4, OD_MARGIN_T + (r + 0.5) * OD_CELL_H);
  }

  const { min, max } = state.odRange || { min: 0, max: 1 };
  const span = max - min || 1;

  for (const w of state.wells) {
    const x = w.x - OD_CELL_W / 2 + 3;
    const y = w.y - OD_CELL_H / 2 + 3;
    const cw = OD_CELL_W - 6;
    const ch = OD_CELL_H - 6;
    const has = isFinite(w.reading);

    roundRect(ctx, x, y, cw, ch, 8);

    // `paint` follows what is ACTUALLY on the cell, layer by layer, so the text
    // colour below is computed from the real thing instead of inferred from the
    // OD. It used to key off `t > 0.62` — fine when every sample wore one flat
    // green, wrong the moment a DARK group green started darkening a cell without
    // touching its OD.
    let paint = { r: 236, g: 238, b: 243 };
    if (has) {
      const t = (w.reading - min) / span;
      paint = odCellColor(t);
      ctx.fillStyle = `rgb(${paint.r},${paint.g},${paint.b})`;
      ctx.fill();
      // A sample is tinted with ITS GROUP's green so neighbouring samples read
      // apart at a glance; other roles keep their flat role tint. Kept light
      // either way: it must tint the cell without burying the OD shading
      // underneath, which is doing real work.
      const groupGreen = shades.get(w);
      if (groupGreen) {
        ctx.fillStyle = withAlpha(groupGreen, 0.34);
        ctx.fill();
        paint = blend(paint, hexToRgb(groupGreen), 0.34);
      } else if (ROLE_FILL[w.role]) {
        ctx.fillStyle = ROLE_FILL[w.role].replace(/[\d.]+\)$/, "0.3)");
        ctx.fill();
        paint = blend(paint, rgbaToRgb(ROLE_FILL[w.role]), 0.3);
      }
    } else {
      // A well the block never covered. Visibly not a plate well, so it reads as
      // "outside your data", not as "a well measuring zero".
      ctx.fillStyle = "#eceef3";
      ctx.fill();
    }

    // A sample's border is its GROUP's green, so where one sample ends and the
    // next begins is visible without reading the labels. Everything else keeps
    // its role colour.
    ctx.strokeStyle = has
      ? (shades.get(w) || ROLE_COLOR[w.role] || "#cbd0dc")
      : "#e2e5ec";
    ctx.lineWidth = w.role === "unused" ? 1.5 : 3;
    ctx.stroke();

    if (!has) continue;

    // Well name, small and quiet in the corner. The OD is the thing being read.
    ctx.fillStyle = luminance(paint) < 0.55 ? "rgba(255,255,255,0.7)" : "rgba(30, 35, 50, 0.5)";
    ctx.font = "600 11px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(w.name, x + 8, y + 12);

    // The reading itself: mono + tabular, the same contract as the results
    // tables, because this is a number that gets read as data.
    const dark = luminance(paint) < 0.55; // is the cell dark enough to need light ink?
    ctx.fillStyle = dark ? "#ffffff" : "#1e2332";
    ctx.font = '500 17px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.fillText(w.reading.toFixed(3), w.x, w.y + 6);

    // What the row field named it — the ladder rung or the sample name. Without
    // this, tagging 8 rows of a ladder is a memory test.
    if (w.label) {
      ctx.fillStyle = dark ? "rgba(255,255,255,0.85)" : "rgba(30, 35, 50, 0.62)";
      ctx.font = "600 11px system-ui";
      ctx.fillText(String(w.label).slice(0, 12), w.x, y + ch - 9);
    }
  }
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function redraw() {
  // One pass over the groups, shared by both renderers.
  const shades = sampleShades();

  // The OD path has no source image — the plate is drawn, not photographed.
  if (state.source === "od") {
    drawODPlate(shades);
    drawSelectionBox();
    return;
  }

  if (!state.baseImageData) return;
  // Restore the clean image, then draw overlays on top.
  ctx.putImageData(state.baseImageData, 0, 0);

  // Corner markers: yellow ring + label at each marked corner. Before the grid
  // is built (still clicking) they are labelled in click order; once built the
  // corners are position-sorted, so the labels land on the true A1/A12/H1/H12.
  ctx.lineWidth = Math.max(2, state.naturalW / 400);
  state.corners.forEach((p, i) => {
    ctx.strokeStyle = "#ffd166";
    ctx.beginPath();
    ctx.arc(p.x, p.y, state.wellRadius || 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#ffd166";
    ctx.font = `${Math.max(12, state.naturalW / 50)}px system-ui`;
    ctx.fillText(["A1", "A12", "H1", "H12"][i], p.x + 8, p.y - 8);
  });

  // Wells (after grid built).
  const roleColor = ROLE_COLOR;
  const roleFill = ROLE_FILL;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const w of state.wells) {
    ctx.beginPath();
    ctx.arc(w.x, w.y, state.wellRadius, 0, Math.PI * 2);
    const groupGreen = shades.get(w);
    if (groupGreen) {
      ctx.fillStyle = withAlpha(groupGreen, 0.5);
      ctx.fill();
    } else if (roleFill[w.role]) {
      ctx.fillStyle = roleFill[w.role];
      ctx.fill();
    }
    ctx.strokeStyle = shades.get(w) || roleColor[w.role] || roleColor.unused;
    ctx.lineWidth = w.role === "unused" ? 1 : Math.max(2, state.naturalW / 400);
    ctx.stroke();
    // Well name (A1..H12) centered in the circle. White fill with a dark outline
    // so it stays legible on both clear wells and dark purple standards.
    const fs = Math.max(9, state.wellRadius * 0.6);
    ctx.font = `600 ${fs}px system-ui`;
    ctx.lineWidth = Math.max(1, fs * 0.14);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(w.name, w.x, w.y);
    ctx.fillText(w.name, w.x, w.y);
  }
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";

  drawSelectionBox();
}

// The rubber-band selection box, while dragging in a tagging phase, plus a live
// highlight on every well it touches — so you see exactly what you are about to
// tag before you let go. Shared by both renderers: box-select is the same gesture
// whether the wells hold pixels or ODs, so it must look the same too.
function drawSelectionBox() {
  if (!(selecting && selMoved && selStart && selCur)) return;
  const b = selectionBox();
  const od = state.source === "od";
  ctx.save();
  for (const w of wellsInSelection()) {
    if (od) {
      roundRect(ctx, w.x - OD_CELL_W / 2 + 3, w.y - OD_CELL_H / 2 + 3, OD_CELL_W - 6, OD_CELL_H - 6, 8);
    } else {
      ctx.beginPath();
      ctx.arc(w.x, w.y, state.wellRadius, 0, Math.PI * 2);
    }
    ctx.fillStyle = "rgba(124, 92, 255, 0.35)";
    ctx.fill();
    ctx.strokeStyle = "#7c5cff";
    ctx.lineWidth = od ? 3 : Math.max(3, state.naturalW / 300);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(124, 92, 255, 0.12)";
  ctx.strokeStyle = "#7c5cff";
  ctx.lineWidth = od ? 2 : Math.max(2, state.naturalW / 500);
  ctx.setLineDash([10, 7]);
  ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  ctx.restore();
}

// ============================================================
// Demo plate generator
// Builds a synthetic 96-well plate so the whole flow can be tried with no photo.
// Layout: column 1 = BSA standard series (A1=0 blank ... H1=2000),
//         3 unknown samples in column 3 with known "true" values to check recovery.
// ============================================================

// The demo button was removed from the UI (2026-07-16). The generator below is
// kept intact — our fastest test path — and re-wires itself if the button ever
// returns to index.html. Guarded so its absence never crashes page load.
const demoBtn = $("demoBtn");
if (demoBtn) {
  demoBtn.addEventListener("click", () => {
    const demo = generateDemoPlate();
    loadImageFromURL(demo.dataURL);
    // Once the image is in, auto-mark corners + roles so results appear instantly.
    // Small timeout lets loadImageFromURL's async onload finish first.
    const t = setInterval(() => {
      if (!state.baseImageData) return;
      clearInterval(t);
      autoSetupDemo(demo);
    }, 30);
  });
}

// Map a concentration (0..2000 µg/mL) to a believable BCA purple color.
// Higher protein -> green drops most, red drops some, blue stays high => purple.
function concToColor(conc) {
  const t = Math.min(1, conc / 2000);
  return {
    r: Math.round(232 - t * 60),
    g: Math.round(230 - t * 150),
    b: Math.round(236 - t * 18),
  };
}

function generateDemoPlate() {
  const cell = 56;                 // px per well cell
  const margin = 40;
  const w = margin * 2 + COLS * cell;
  const h = margin * 2 + ROWS * cell;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");

  // Plate body.
  g.fillStyle = "#dfe3e8";
  g.fillRect(0, 0, w, h);
  g.fillStyle = "#cfd4da";
  roundRect(g, 12, 12, w - 24, h - 24, 16); g.fill();

  // Standard series down column 1.
  const stdConcs = [0, 125, 250, 500, 750, 1000, 1500, 2000];
  // Unknown samples in column 3 (rows A,B,C) with hidden "true" values.
  const sampleTruth = { 0: 300, 1: 900, 2: 1600 }; // row -> conc

  const wellR = cell * 0.38;
  for (let r = 0; r < ROWS; r++) {
    for (let col = 0; col < COLS; col++) {
      const cx = margin + col * cell + cell / 2;
      const cy = margin + r * cell + cell / 2;

      // Every well starts as a faint, empty buffer — no pre-baked purple. The
      // demo's "true" signal lives on the well objects (set in autoSetupDemo),
      // not in these pixels, so the plate looks clean and a well only turns
      // purple once you tag it as a standard/sample.
      const noise = () => (Math.random() - 0.5) * 4;
      g.fillStyle = `rgb(${238 + noise()},${238 + noise()},${240 + noise()})`;
      g.beginPath(); g.arc(cx, cy, wellR, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(0,0,0,0.12)"; g.lineWidth = 1; g.stroke();
    }
  }

  return {
    dataURL: c.toDataURL("image/png"),
    geom: { margin, cell },
    stdConcs,
    sampleTruth,
  };
}

// Auto-place corners on the known demo geometry and tag standards/samples.
function autoSetupDemo(demo) {
  const { margin, cell } = demo.geom;
  const centerOf = (r, col) => ({
    x: margin + col * cell + cell / 2,
    y: margin + r * cell + cell / 2,
  });
  state.corners = [
    centerOf(0, 0), centerOf(0, COLS - 1),
    centerOf(ROWS - 1, 0), centerOf(ROWS - 1, COLS - 1),
  ];
  buildGrid();
  state.mode = "assign";
  updateCornerStatus();

  // Tag wells, and stash the "true" BCA color each well WOULD have. The plate
  // pixels are intentionally blank now, so compute reads w.demoColor instead —
  // that's how the demo recovers the known concentrations from a clean plate.
  // A little noise keeps the fit from being unrealistically perfect.
  const demoNoise = () => (Math.random() - 0.5) * 6;
  const trueColor = (conc) => {
    const c = concToColor(conc);
    return { r: c.r + demoNoise(), g: c.g + demoNoise(), b: c.b + demoNoise() };
  };
  // Column 1 = the BSA standard ladder (+ blank). Column 3 rows A-C = three
  // unknowns with hidden true values, so the demo actually DEMONSTRATES recovery
  // (~300/900/1600) instead of computing a curve with an empty sample table.
  for (const w of state.wells) {
    if (w.col === 0) {
      const conc = demo.stdConcs[w.row];
      if (conc === 0) { w.role = "blank"; w.conc = 0; }
      else { w.role = "standard"; w.conc = conc; w.label = `${conc}`; }
      w.demoColor = trueColor(conc);
    } else if (w.col === 2 && demo.sampleTruth[w.row] !== undefined) {
      w.role = "sample";
      w.label = `Unknown ${String.fromCharCode(65 + w.row)}`;
      w.demoColor = trueColor(demo.sampleTruth[w.row]);
    }
  }
  revealGridStep();
  setTray(true);
  setVerdict("placed");
  redraw();
  // Show the plate with its tagged wells; the user reviews, then hits Compute
  // (or "Looks right").
  $("gridCard").scrollIntoView({ behavior: "smooth" });
}

// Helper: rounded rectangle path.
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
