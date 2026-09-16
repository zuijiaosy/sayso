#!/usr/bin/env bun
/**
 * Renders `src/assets/sayso-mark.svg` into the 1024x1024 app-icon master at
 * `src-tauri/icons/logo.png`, which `tauri icon` then fans out into every
 * platform size. Run both with `bun run icons`.
 *
 * The mark is drawn edge-to-edge in its own viewBox, but a macOS app icon wants
 * transparent margin around the squircle: on the Big Sur grid a 1024 canvas
 * holds an 824 squircle. `tauri icon` only resizes, so that padding has to be
 * baked in here.
 *
 * Requires `rsvg-convert` (`brew install librsvg`).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARK = path.join(ROOT, "src/assets/sayso-mark.svg");
const DEST = path.join(ROOT, "src-tauri/icons/logo.png");

const CANVAS = 1024;
const SQUIRCLE = 824; // Big Sur icon grid.
const MARK_VIEWBOX = 256; // Must match the viewBox in sayso-mark.svg.

const scale = SQUIRCLE / MARK_VIEWBOX;
const offset = (CANVAS - SQUIRCLE) / 2;

const mark = fs.readFileSync(MARK, "utf8");
const inner = mark
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "");

const padded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">
  <g transform="translate(${offset},${offset}) scale(${scale})">${inner}</g>
</svg>`;

execFileSync(
  "rsvg-convert",
  ["-w", String(CANVAS), "-h", String(CANVAS), "-o", DEST],
  { input: padded },
);
if (fs.statSync(DEST).size === 0) throw new Error(`empty render: ${DEST}`);

console.log(`  ${path.relative(ROOT, DEST)} (${CANVAS}x${CANVAS})`);
console.log("Now run `tauri icon` to fan this out (or just `bun run icons`).");
