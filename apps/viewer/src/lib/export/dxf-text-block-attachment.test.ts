/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { DxfUnderlayRenderData } from '@/hooks/useDxfUnderlay.js';
import { drawingWithDxfBounds } from '@/hooks/dxfDrawingBounds.js';
import { drawDxfUnderlaysScreenSpace } from '@/components/viewer/drawing-underlays.js';
import { buildDxfUnderlaySvg, drawDxfUnderlaysPdf, mappedDxfUnderlayOptions } from './drawing-vector-underlays.js';

/**
 * DXF anchors a whole MTEXT block at its insertion point: top attachment
 * (71 = 1–3) grows down from it, middle (4–6) is centred on it, bottom
 * (7–9) grows up from it with the last line on the point. Every renderer
 * and the fit bounds must agree.
 */

const PAGE_MM = 100;
const PT_PER_MM = 72 / 25.4;
const CAP_HEIGHT_EM = 0.718;
const DESCENT_EM = 0.207;
// Drawing metres → page mm / screen px (×10), y up in the drawing and down on the page.
const mapPoint = (x: number, y: number) => ({ x: 50 + x * 10, y: 50 - y * 10 });
const SIZE = 5; // 0.5 m text → 5 mm / 5 px
const GAP = SIZE * 5 / 3; // AutoCAD MTEXT pitch at spacing factor 1

type Valign = 'top' | 'middle' | 'bottom';
type Text = DxfUnderlayRenderData['texts'][number];
const ATTACHMENTS: Array<{ valign: Valign; label: string; offsets: number[] }> = [
  { valign: 'top', label: 'attachment 1', offsets: [0, GAP, 2 * GAP] },
  { valign: 'middle', label: 'attachment 4', offsets: [-GAP, 0, GAP] },
  { valign: 'bottom', label: 'attachment 7', offsets: [-2 * GAP, -GAP, 0] },
];
const DIRECTIONS = [
  { name: '0°', dirX: 1, dirY: 0, deg: 0 },
  { name: '90°', dirX: 0, dirY: 1, deg: -90 },
];

function text(valign: Valign, dirX: number, dirY: number): Text {
  return { x: 2, y: 3, dirX, dirY, height: 0.5, text: 'One\nTwo\nSix', color: '#000000', align: 'left', valign };
}
function underlay(t: Text): DxfUnderlayRenderData[] {
  return [{ id: 'dxf', opacity: 1, lines: [], fills: [], texts: [t] }];
}
function near(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 0.01, `${label}: ${actual.toFixed(3)}, expected ${expected.toFixed(3)}`);
}

describe('multi-line DXF text block attachment', () => {
  it('canvas stacks the block about its insertion point in the rotated text frame', () => {
    for (const { valign, label, offsets } of ATTACHMENTS) {
      for (const dir of DIRECTIONS) {
        const calls: Array<{ text: string; x: number; y: number; baseline: string }> = [];
        const transforms: Array<[string, ...number[]]> = [];
        const ctx = {
          save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
          setLineDash() {},
          translate(x: number, y: number) { transforms.push(['translate', x, y]); },
          rotate(a: number) { transforms.push(['rotate', a]); },
          fillText(this: { textBaseline: string }, t: string, x: number, y: number) { calls.push({ text: t, x, y, baseline: this.textBaseline }); },
          textBaseline: 'alphabetic',
        } as unknown as CanvasRenderingContext2D;
        drawDxfUnderlaysScreenSpace(ctx, underlay(text(valign, dir.dirX, dir.dirY)), mapPoint, w => w, h => h * 10);
        assert.deepEqual(transforms[0], ['translate', 70, 20], `${label} ${dir.name}: anchored at the insertion point`);
        near(transforms[1][1], dir.deg * Math.PI / 180, `${label} ${dir.name} rotation`);
        assert.deepEqual(calls.map(c => c.text), ['One', 'Two', 'Six']);
        calls.forEach((c, i) => {
          near(c.x, 0, `${label} ${dir.name} line ${i} along`);
          near(c.y, offsets[i], `${label} ${dir.name} line ${i} across`);
          assert.equal(c.baseline, valign);
        });
      }
    }
  });

  it('SVG places every tspan at its block offset in the rotated text frame', () => {
    for (const { valign, label, offsets } of ATTACHMENTS) {
      for (const dir of DIRECTIONS) {
        const svg = buildDxfUnderlaySvg(underlay(text(valign, dir.dirX, dir.dirY)), mapPoint, mm => mm, 10, s => s);
        const lines = [...svg.matchAll(/<tspan x="([-\d.]+)" y="([-\d.]+)">/g)].map(m => [Number(m[1]), Number(m[2])]);
        assert.equal(lines.length, 3);
        // Absolute x/y sit inside the text's rotate() about the anchor (70, 20).
        lines.forEach(([x, y], i) => { near(x, 70, `${label} ${dir.name} line ${i} along`); near(y, 20 + offsets[i], `${label} ${dir.name} line ${i}`); });
        assert.match(svg, new RegExp(`rotate\\(${dir.deg.toFixed(2)} 70\\.0000 20\\.0000\\)`));
      }
    }
  });

  it('SVG keeps the block offset when a line is empty (PR #10195 review)', () => {
    const ys = (body: string) => [...buildDxfUnderlaySvg(underlay({ ...text('bottom', 1, 0), text: body }), mapPoint, mm => mm, 10, s => s)
      .matchAll(/<tspan x="[-\d.]+" y="([-\d.]+)">([^<]*)</g)].map(m => [Number(m[1]), m[2]] as const);
    // Leading empty line: "B" sits on the insertion point, not a line below it.
    const leading = ys('\nB');
    assert.deepEqual(leading.map(l => l[1]), ['', 'B']);
    near(leading[0][0], 20 - GAP, 'leading empty line');
    near(leading[1][0], 20, 'B on the point');
    const middle = ys('A\n\nC');
    [-2 * GAP, -GAP, 0].forEach((o, i) => near(middle[i][0], 20 + o, `empty middle line ${i}`));
  });

  it('PDF places every line of the block across the rotated baseline', () => {
    const drop: Record<Valign, number> = { top: CAP_HEIGHT_EM * SIZE, middle: CAP_HEIGHT_EM * SIZE / 2, bottom: -DESCENT_EM * SIZE };
    for (const { valign, label, offsets } of ATTACHMENTS) {
      for (const dir of DIRECTIONS) {
        const doc = new jsPDF({ unit: 'mm', format: [PAGE_MM, PAGE_MM] });
        drawDxfUnderlaysPdf(doc, underlay(text(valign, dir.dirX, dir.dirY)), mapPoint, 10);
        // jsPDF writes a rotated line's start into a Tm matrix, an unrotated one as Td.
        const lines = [...doc.output().matchAll(/([-\d.]+) ([-\d.]+) (?:Td|Tm)\n\(([^)]*)\) Tj/g)]
          .map(m => ({ text: m[3], x: Number(m[1]) / PT_PER_MM, y: PAGE_MM - Number(m[2]) / PT_PER_MM }));
        assert.deepEqual(lines.map(l => l.text), ['One', 'Two', 'Six']);
        // "Down" towards the glyph feet: page +y at 0°, page +x at 90°.
        const down = dir.deg === 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
        lines.forEach((line, i) => {
          near(line.x, 70 + down.x * (offsets[i] + drop[valign]), `${label} ${dir.name} line ${i} x`);
          near(line.y, 20 + down.y * (offsets[i] + drop[valign]), `${label} ${dir.name} line ${i} y`);
        });
      }
    }
  });

  it('package export options carry the block offset per line', () => {
    for (const { valign, label, offsets } of ATTACHMENTS) {
      for (const dir of DIRECTIONS) {
        const [{ underlay: mapped }] = mappedDxfUnderlayOptions(underlay(text(valign, dir.dirX, dir.dirY)), 'down');
        const texts = mapped.layers[0].texts;
        assert.deepEqual(texts.map(t => t.text), ['One', 'Two', 'Six']);
        texts.forEach((t, i) => {
          // Stacking in drawing metres follows the canvas: +offset is (-dirY, dirX).
          near(t.position.x, 2 - dir.dirY * offsets[i] / 10, `${label} ${dir.name} line ${i} x`);
          near(t.position.y, 3 + dir.dirX * offsets[i] / 10, `${label} ${dir.name} line ${i} y`);
          assert.equal(t.valign, valign);
        });
      }
    }
  });

  it('fit bounds enclose the whole attached block, and no more than its mirror', () => {
    const drawing = { lines: [], cutPolygons: [], projectionPolygons: [], bounds: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } } } as unknown as Drawing2D;
    for (const { valign, label, offsets } of ATTACHMENTS) {
      for (const dir of DIRECTIONS) {
        const t = { ...text(valign, dir.dirX, dir.dirY), height: 1 };
        const bounds = drawingWithDxfBounds(drawing, underlay(t))!.bounds;
        for (const sign of [-1, 1]) {
          for (const [i] of offsets.entries()) {
            for (const glyph of [-1, 1]) {
              const across = sign * (offsets[i] / SIZE + glyph);
              const p = { x: t.x - dir.dirY * across, y: t.y + dir.dirX * across };
              assert.ok(p.x >= bounds.min.x - 1e-9 && p.x <= bounds.max.x + 1e-9, `${label} ${dir.name} x`);
              assert.ok(p.y >= bounds.min.y - 1e-9 && p.y <= bounds.max.y + 1e-9, `${label} ${dir.name} y`);
            }
          }
        }
        // Across-baseline extent: one glyph height beyond the farthest line, mirrored.
        const reach = 1 + Math.max(...offsets.map(o => Math.abs(o / SIZE)));
        const span = dir.deg === 0 ? bounds.max.y - bounds.min.y : bounds.max.x - bounds.min.x;
        near(span, 2 * reach, `${label} ${dir.name} across extent`);
      }
    }
  });
});
