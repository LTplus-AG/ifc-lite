/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Reads facts back from the bytes of the evidence PDFs (#6681); nothing here comes from the composer.
 *   node docs/architecture/evidence/block-scale-frame-6681/readback.mjs <dir with the four PDFs>
 * Tools: `pdfinfo` (page count and page size), `pdftotext -bbox` (word boxes), and pdf.js 6.3.289 from the
 * viewer's own dependencies (the operator list: the image box is the current transform at each
 * `paintImageXObject`). Coordinates are points from the top-left of the page. The printable frame is the
 * document's own: 40 pt margins, a 30 pt header and a 24 pt footer, so it ends at page height - 64. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = process.argv[2] ?? '.';
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const requireFromViewer = createRequire(join(root, 'apps/viewer/package.json'));
const pdfjs = await import(pathToFileURL(requireFromViewer.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const MARGIN = 40;
const FOOTER = 24;

function pages(file) {
  const info = execFileSync('pdfinfo', ['-f', '1', '-l', '99', file], { encoding: 'utf8' });
  const count = Number(info.match(/^Pages:\s+(\d+)/m)[1]);
  const sizes = [...info.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((m) => ({ page: Number(m[1]), w: Number(m[2]), h: Number(m[3]) }));
  return { count, sizes };
}

function words(file) {
  const html = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
  const out = [];
  let page = 0;
  for (const line of html.split('\n')) {
    if (line.includes('<page ')) page += 1;
    const m = line.match(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*)<\/word>/);
    if (m) out.push({ page, x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: m[5] });
  }
  return out;
}

async function images(file) {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(requireFromViewer.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  const doc = await task.promise;
  const found = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const height = page.view[3];
    const { fnArray, argsArray } = await page.getOperatorList();
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const mul = (m, t) => [m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1], m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3], m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5]];
    fnArray.forEach((fn, i) => {
      if (fn === pdfjs.OPS.save) stack.push(ctm);
      else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, argsArray[i]);
      else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
        const [a, , , d, e, f] = ctm;
        found.push({ page: n, x0: e, x1: e + a, y0: height - (f + d), y1: height - f });
      }
    });
    page.cleanup();
  }
  await task.destroy();
  return found;
}

const fmt = (n) => n.toFixed(1);
for (const name of ['finding1-landscape-snapshot-200', 'finding2-two-half-charts-150']) {
  for (const tag of ['main', 'branch']) {
    const file = join(dir, `${name}-${tag}.pdf`);
    const { count, sizes } = pages(file);
    const frameBottom = sizes[0].h - MARGIN - FOOTER;
    console.log(`\n== ${name}-${tag}.pdf: ${count} page(s), page ${sizes[0].w} x ${sizes[0].h} pt, printable frame bottom ${fmt(frameBottom)}, right ${fmt(sizes[0].w - MARGIN)}`);
    const imgs = await images(file);
    for (const img of imgs) console.log(`  image (snapshot) page ${img.page}: x ${fmt(img.x0)}..${fmt(img.x1)}, y ${fmt(img.y0)}..${fmt(img.y1)} => ${img.y1 > frameBottom + 0.05 ? `CROSSES the frame bottom by ${fmt(img.y1 - frameBottom)} pt` : `inside the frame (${fmt(frameBottom - img.y1)} pt to spare)`}`);
    const ws = words(file);
    const content = ws.filter((w) => w.y0 > MARGIN + 30 - 5 && w.y1 < sizes[0].h - 30);
    if (name.startsWith('finding1')) {
      const low = content.reduce((a, b) => (b.y1 > a.y1 ? b : a), content[0]);
      console.log(`  lowest word between header and footer: "${low.text}" page ${low.page}, bottom ${fmt(low.y1)}`);
    } else {
      for (const w of ws.filter((x) => x.text === 'A' || x.text === 'B')) {
        const prev = ws.filter((p) => p.page === w.page && p.text === 'Chart' && Math.abs(p.y0 - w.y0) < 1 && p.x1 <= w.x0 + 1).sort((a, b) => b.x1 - a.x1)[0];
        if (prev) console.log(`  title "Chart ${w.text}": page ${w.page}, x ${fmt(prev.x0)}..${fmt(w.x1)}, y ${fmt(prev.y0)}..${fmt(w.y1)}`);
      }
    }
  }
}
