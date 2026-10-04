/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Reads facts back from the bytes of the evidence PDFs; nothing here comes from the composer.
 *   node docs/architecture/evidence/block-heading-follow-ups/readback.mjs <dir with the four PDFs>
 * Tools: `pdfinfo` (page size), `pdftotext -bbox` (word boxes; poppler drops text that starts outside the
 * page, which the report says where it matters), pdf.js 6.3.289 from the viewer's own dependencies
 * (`getTextContent`: each text item's position and width, kept even when it is off the page), and
 * `pdftoppm -r 72` (one pixel per point; the yellow strip is the run of #ffff00 pixels). Coordinates are
 * points from the top-left of the page. The printable frame ends 40 pt from the right edge. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = process.argv[2] ?? '.';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const requireFromViewer = createRequire(join(root, 'apps/viewer/package.json'));
const pdfjs = await import(pathToFileURL(requireFromViewer.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const MARGIN = 40;
const fmt = (n) => n.toFixed(1);

function pageSize(file) {
  const m = execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);
  return { w: Number(m[1]), h: Number(m[2]) };
}

function words(file) {
  const html = execFileSync('pdftotext', ['-bbox', '-f', '1', '-l', '1', file, '-'], { encoding: 'utf8' });
  return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*)<\/word>/g)]
    .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5] }));
}

async function textItems(file) {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(requireFromViewer.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const height = page.view[3];
  const { items } = await page.getTextContent();
  await task.destroy();
  return items.filter((i) => i.str.trim()).map((i) => ({ text: i.str, x0: i.transform[4], x1: i.transform[4] + i.width, baseline: height - i.transform[5], size: Math.abs(i.transform[3]) }));
}

/** Runs of #ffff00 pixels along the strip's first full row (above the glyphs), as [x0, x1) pairs, and the first and last yellow row. */
function strips(file) {
  const tmp = mkdtempSync(join(tmpdir(), 'heading-readback-'));
  try {
    execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', '-singlefile', file, join(tmp, 'p')]);
    const ppm = readFileSync(join(tmp, 'p.ppm'));
    const header = ppm.toString('latin1', 0, 30).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
    const w = Number(header[1]); const h = Number(header[2]);
    const data = ppm.subarray(header[0].length);
    const yellow = (x, y) => { const o = (y * w + x) * 3; return data[o] > 240 && data[o + 1] > 240 && data[o + 2] < 40; };
    let top = -1; let bottom = -1;
    for (let y = 0; y < h; y++) { let any = false; for (let x = 0; x < w && !any; x++) any = yellow(x, y); if (any) { if (top < 0) top = y; bottom = y + 1; } }
    const mid = top < 0 ? 0 : top + 1;
    const runs = [];
    for (let x = 0, start = -1; x <= w; x++) {
      const on = x < w && yellow(x, mid);
      if (on && start < 0) start = x;
      if (!on && start >= 0) { runs.push([start, x]); start = -1; }
    }
    return { top, bottom, runs };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

for (const name of ['f1-topic-fallback-title', 'f3-chart-beside-text']) {
  for (const tag of ['main', 'branch']) {
    const file = join(dir, `${name}-${tag}.pdf`);
    const size = pageSize(file);
    const right = size.w - MARGIN;
    const s = strips(file);
    console.log(`\n== ${name}-${tag}.pdf: page ${size.w} x ${size.h} pt, right margin edge ${fmt(right)}`);
    console.log(`  strip rows ${s.top}..${s.bottom} (height ${s.bottom - s.top} pt), runs on the strip's first full row: ${s.runs.map(([a, b]) => `x ${a}..${b}`).join(' | ') || 'none'}`);
    if (name.startsWith('f1')) {
      const items = (await textItems(file)).filter((i) => i.size > 20);
      for (const i of items) console.log(`  pdf.js heading item "${i.text}" size ${fmt(i.size)} x ${fmt(i.x0)}..${fmt(i.x1)} => ${i.x1 > right + 0.05 ? `PAST the right margin by ${fmt(i.x1 - right)} pt` : 'inside the margin'}${s.runs[0] && i.x1 > s.runs[0][1] + 0.5 ? `; PAST the strip's end ${s.runs[0][1]} by ${fmt(i.x1 - s.runs[0][1])} pt` : '; inside the strip'}`);
      const w = words(file).filter((x) => x.y1 - x.y0 > 20);
      console.log(`  pdftotext -bbox heading words on the page: ${w.length ? w.map((x) => `"${x.text}" ${fmt(x.x0)}..${fmt(x.x1)}`).join(', ') : 'none'}`);
    } else {
      const items = (await textItems(file)).filter((i) => i.size > 15);
      for (const i of items) console.log(`  pdf.js heading item "${i.text}" size ${fmt(i.size)} x ${fmt(i.x0)}..${fmt(i.x1)}`);
      const [chart, text] = s.runs;
      if (chart && text) console.log(`  chart strip x ${chart[0]}..${chart[1]}, text strip x ${text[0]}..${text[1]}: the two columns' strips are ${chart[1] - chart[0]} and ${text[1] - text[0]} pt wide`);
    }
  }
}
