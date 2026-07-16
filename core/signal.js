// ============================================================
// Pixels → a single number the curve can be fitted against.
// Pure; no DOM. The caller supplies raw pixel bytes, so this works identically
// in a browser (from canvas ImageData) and in Node (from the offline harness).
// ============================================================

// Average the R/G/B of all pixels within `radius` of (cx, cy).
//
// `pixels` is a flat RGBA byte array (canvas ImageData.data layout), `width` and
// `height` its dimensions. Taking these as arguments rather than reading a
// global `state` is the whole point of the core/edge split: the science does not
// get to know a canvas exists.
export function sampleColorAt(pixels, width, height, cx, cy, radius) {
  let rSum = 0, gSum = 0, bSum = 0, n = 0;
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r2) continue; // keep it circular
      const i = (y * width + x) * 4;
      rSum += pixels[i]; gSum += pixels[i + 1]; bSum += pixels[i + 2]; n++;
    }
  }
  if (n === 0) return { r: 0, g: 0, b: 0 };
  return { r: rSum / n, g: gSum / n, b: bSum / n };
}

// Turn an RGB color into a single "signal" number per the chosen channel.
// BCA's product is purple, which absorbs green, so green gets darker as protein
// rises -> (255 - green) increases with concentration. That's the default.
//
// Worth knowing before adding channels: on a real plate the green channel
// bottoms out at high purple before the CHEMISTRY saturates (CONTEXT.md,
// 2026-07-14). The ceiling here is the camera's, not the assay's.
export function colorToSignal(color, channel) {
  const { r, g, b } = color;
  if (channel === "bg") {
    return b / Math.max(1, g);                 // blue/green ratio
  } else if (channel === "sat") {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;  // HSV saturation
  }
  return 255 - g;                              // green absorbance (default)
}
