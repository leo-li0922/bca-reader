# BCA Reader

Turn a 96-well BCA protein assay into concentrations and a gel loading plan.

**Live: https://leo-li0922.github.io/bca-reader/**

Two ways in:

- **Plate reader data** (the accurate path) — paste the block of OD readings out
  of your spreadsheet. The app fits the curve to your own ladder, so it never
  depends on a slope value copied off a trendline label. (An Excel trendline label
  is rounded for display: a real slope of 0.000741 prints as `0.0007`, and
  dividing by that inflates every concentration by ~5.9%.)
- **Plate photo** — photograph the plate. Convenient, less accurate: it reads
  about 5% high, and more on a lighting gradient.

Then tag the blanks, the ladder and your samples, and it returns concentrations
plus the µL of sample / lysis buffer / dye per tube for equal protein mass in
every lane.

## Your data never leaves your browser

There is no server, no upload and no analytics. The page is static files; the
photo and the readings are processed in the tab and go nowhere. You can read every
line of that claim in `bca-reader/` and `core/`.

## Structure

- `core/` — the science. Curve fits, statistics, thresholds, the loading plan.
  No DOM. One implementation, shared by every surface.
- `bca-reader/` — the UI. Collects input, renders answers, does no science.

Published from a private source repo by a deploy script that copies and never
edits, so this can't drift from the tested code.

_Educational tool. Check the numbers against your own before you trust a gel to them._
