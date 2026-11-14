/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import type { DxfUnderlayRenderData } from '@/hooks/useDxfUnderlay.js';
import { drawDxfUnderlaysPdf } from './drawing-vector-underlays.js';

const PAGE_MM = 100;
const PT_PER_MM = 72 / 25.4;
const CAP_HEIGHT_EM = 0.718;
const DESCENT_EM = 0.207;
const LINE_HEIGHT = 1.3;
// Drawing metres → page mm, y up in the drawing and down on the page.
const mapPoint = (x: number, y: number) => ({ x: 50 + x * 10, y: 50 - y * 10 });
const metresToMm = 10;

type Text = DxfUnderlayRenderData['texts'][number];
function underlay(text: Partial<Text>): DxfUnderlayRenderData[] {
  return [{ id: 'dxf', opacity: 1, lines: [], fills: [], texts: [{ x: 2, y: 3, dirX: 1, dirY: 0, height: 0.5,
    text: 'Wall', color: '#000000', align: 'left', valign: 'baseline', ...text }] }];
}

/** Each emitted line's text matrix: the rotation and the baseline start in page mm (y down). */
function textMatrices(doc: jsPDF): Array<{ text: string; m: number[]; x: number; y: number }> {
  const out: Array<{ text: string; m: number[]; x: number; y: number }> = [];
  for (const match of doc.output().matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm\n\(([^)]*)\) Tj/g)) {
    const m = match.slice(1, 7).map(Number);
    out.push({ text: match[7], m: m.slice(0, 4), x: m[4] / PT_PER_MM, y: PAGE_MM - m[5] / PT_PER_MM });
  }
  return out;
}

function widthMm(text: string, sizeMm: number): number {
  const doc = new jsPDF({ unit: 'mm', format: [PAGE_MM, PAGE_MM] });
  doc.setFontSize(sizeMm * PT_PER_MM);
  return doc.getTextWidth(text);
}

function draw(text: Partial<Text>) {
  const doc = new jsPDF({ unit: 'mm', format: [PAGE_MM, PAGE_MM] });
  drawDxfUnderlaysPdf(doc, underlay(text), mapPoint, metresToMm);
  return textMatrices(doc);
}

function near(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 0.01, `${label}: ${actual.toFixed(3)} mm, expected ${expected.toFixed(3)} mm`);
}

describe('vector PDF DXF text justification along rotated baselines', () => {
  it('centres a 90° middle-justified TEXT on its alignment point', () => {
    // Anchor (2,3) → page (70,20). The baseline runs up the page, so "along"
    // is page -y and "down" (towards the glyph feet) is page +x.
    const [line] = draw({ dirX: 0, dirY: 1, align: 'center', valign: 'middle' });
    assert.ok(line);
    assert.deepEqual(line.m.map(v => Math.round(v)), [0, 1, -1, 0], 'counter-clockwise 90° text matrix');
    const half = widthMm('Wall', 5) / 2;
    near(line.x, 70 + CAP_HEIGHT_EM * 5 / 2, 'across the baseline');
    near(line.y, 20 + half, 'along the baseline');
  });

  it('places right/top justification along a 30° baseline', () => {
    const rad = Math.PI / 6;
    const [line] = draw({ dirX: Math.cos(rad), dirY: Math.sin(rad), align: 'right', valign: 'top' });
    assert.ok(line);
    const along = { x: Math.cos(rad), y: -Math.sin(rad) };
    const down = { x: -along.y, y: along.x };
    const w = widthMm('Wall', 5), drop = CAP_HEIGHT_EM * 5;
    near(line.x, 70 - along.x * w + down.x * drop, 'x');
    near(line.y, 20 - along.y * w + down.y * drop, 'y');
  });

  it('keeps baseline-left TEXT exactly on its insertion point at any angle', () => {
    const [line] = draw({ dirX: -1, dirY: 0 });
    assert.ok(line);
    near(line.x, 70, 'x'); near(line.y, 20, 'y');
  });

  it('lifts bottom-justified TEXT by the descent across a 90° baseline', () => {
    const [line] = draw({ dirX: 0, dirY: 1, valign: 'bottom' });
    assert.ok(line);
    near(line.x, 70 - DESCENT_EM * 5, 'across'); near(line.y, 20, 'along');
  });

  it('stacks rotated multiline MTEXT across the baseline and justifies each line', () => {
    const lines = draw({ dirX: 0, dirY: 1, text: 'Upper\nLow', align: 'center', valign: 'top' });
    assert.deepEqual(lines.map(l => l.text), ['Upper', 'Low']);
    lines.forEach((line, i) => {
      const half = widthMm(line.text, 5) / 2;
      near(line.x, 70 + CAP_HEIGHT_EM * 5 + i * 5 * LINE_HEIGHT, `line ${i} across`);
      near(line.y, 20 + half, `line ${i} along`);
    });
  });
});
