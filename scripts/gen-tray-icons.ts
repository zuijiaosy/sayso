#!/usr/bin/env bun
/**
 * Regenerates the tray PNGs in `src-tauri/resources/` from the SVG sources in
 * `src/assets/tray/`. Run with `bun run icons:tray` after changing a glyph.
 *
 * Requires `rsvg-convert` (`brew install librsvg`). Nothing else: keeping the
 * pipeline to one small CLI avoids adding a raster dependency to package.json
 * for assets that change about once a year.
 *
 * Output names are dictated by `get_icon_path` in `src-tauri/src/tray.rs`:
 * the dark *theme* takes light (white) icons, so `tray_x.png` is white and
 * `tray_x_dark.png` is black. macOS re-tints both as template images anyway;
 * the pair only really matters on Windows.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src/assets/tray");
const OUT = path.join(ROOT, "src-tauri/resources");

/** SVG basename -> state name used in tray.rs resource paths. */
const STATES: Record<string, string> = {
  idle: "idle",
  recording: "recording",
  transcribing: "transcribing",
  warning: "idle_warning",
};

/** States that also get a full-color icon, used by the Linux "colored" theme. */
const COLORED: Record<string, string> = {
  idle: "sayso",
  recording: "recording",
  transcribing: "transcribing",
};

const GRADIENT = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0%" stop-color="#F4633A"/>
  <stop offset="55%" stop-color="#FF8C42"/>
  <stop offset="100%" stop-color="#FFB347"/>
</linearGradient>`;

/** Rasterize an SVG string to `dest` at `size`x`size`. */
function render(svg: string, dest: string, size: number): void {
  execFileSync(
    "rsvg-convert",
    ["-w", String(size), "-h", String(size), "-o", dest],
    { input: svg },
  );
  if (fs.statSync(dest).size === 0) throw new Error(`empty render: ${dest}`);
  console.log(`  ${path.relative(ROOT, dest)}`);
}

/** Strip the outer <svg> wrapper so the glyph can be nested inside a <g>. */
function innerSvg(svg: string): string {
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

fs.mkdirSync(OUT, { recursive: true });

for (const [file, state] of Object.entries(STATES)) {
  const svg = fs.readFileSync(path.join(SRC, `${file}.svg`), "utf8");
  if (!svg.includes('fill="currentColor"')) {
    throw new Error(
      `${file}.svg must paint its glyph with fill="currentColor"`,
    );
  }
  // Only this one token is recolored: the cut-out geometry inside the <mask>
  // keeps its own literal #000/#fff and must not be touched.
  render(
    svg.replace('fill="currentColor"', 'fill="#ffffff"'),
    path.join(OUT, `tray_${state}.png`),
    64,
  );
  render(
    svg.replace('fill="currentColor"', 'fill="#000000"'),
    path.join(OUT, `tray_${state}_dark.png`),
    64,
  );

  // Full-color variant: the white glyph on the brand gradient squircle.
  const colored = COLORED[file];
  if (colored) {
    const glyph = innerSvg(svg).replace(
      'fill="currentColor"',
      'fill="#ffffff"',
    );
    render(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>${GRADIENT}</defs>
  <rect width="256" height="256" rx="58" fill="url(#g)"/>
  <g transform="translate(29,22) scale(3)">${glyph}</g>
</svg>`,
      path.join(OUT, `${colored}.png`),
      64,
    );
  }
}

console.log(
  "\nTray icons regenerated. The app icon is separate: see `bun run icons`.",
);
